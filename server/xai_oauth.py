# Copyright 2026 Codemarchant
"""Sign in with Grok: a SuperGrok or X Premium subscription in place of
the xAI API key.

xAI's OAuth (May 2026) gives a subscriber a bearer token that api.x.ai
takes wherever it takes an API key, drawn from the subscription's weekly
allowance (shared with Grok chat and Grok Build) instead of console
credits. There is no developer registration: Zed, Warp, OpenCode, Hermes,
OpenClaw, LiteLLM and others all sign in as xAI's public Grok CLI client
and name themselves with `referrer`, which xAI's own grok-build code
describes as a "Client-supplied referrer so analytics can attribute OAuth
usage".

Sign-in is the RFC 8628 device-code flow (OpenCode dropped the loopback
redirect because xAI's consent page often shows a code instead of
redirecting): Settings starts it, shows the code and polls until the user
approves. The tokens land in the config row. Access tokens lived 6 hours
when this was written (2026-10-04); Hermes has seen 15-minute ones.

While signed in, get_config()'s xai_api_key IS the access token, so every
xAI call (realtime token mint, Responses, TTS/STT, Imagine, files) runs on
the subscription unchanged. It falls back to the saved API key, if there
is one, while the subscription can't be used:
  * xAI refused it — a 403 on a call (standard SuperGrok got one in May
    2026, Hermes #26847, and so does a spent weekly allowance) or on a
    renewal (an entitlement gate: signing in again won't help);
  * the token expired and renewing it keeps failing (outage, Cloudflare
    challenge, rate limit) — retried with growing gaps.
"Try again" in Settings clears both. Only `invalid_grant` on renewal
(revoked, or the refresh token already used) ends the sign-in, as in
Goose and Zed.
"""
import base64
import json
import logging
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import requests

from .errors import UserError

_logger = logging.getLogger(__name__)

# xAI's public Grok CLI client (no secret), as in xai-org/grok-build.
CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
DEVICE_URL = 'https://auth.x.ai/oauth2/device/code'
TOKEN_URL = 'https://auth.x.ai/oauth2/token'
USERINFO_URL = 'https://auth.x.ai/oauth2/userinfo'
REVOKE_URL = 'https://auth.x.ai/oauth2/revoke'
# The subscription's usage, as Grok CLI and OpenClaw read it. Answers
# without their x-grok-client-* headers (checked 2026-10-04).
BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
# grok-cli:access "authorizes the token for API proxy requests"
# (grok-build's config.rs); the same set OpenCode and Zed request.
SCOPE = 'openid profile email offline_access grok-cli:access api:access'
REFERRER = 'rexclaw'
DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
HEADERS = {'Accept': 'application/json', 'User-Agent': 'Rexclaw'}
TIMEOUT = 15
# Renew this long before expiry (at most a quarter of the token's
# lifetime): callers read the key once per job — a delegate task, a
# summary — so it must outlast the job's last request. OpenCode renews
# 2 minutes ahead because it reads the token per request.
RENEW_EARLY = 600
# After a failed renewal: wait 1 minute, doubling to at most an hour.
RENEW_RETRY = 60
RENEW_RETRY_MAX = 3600
# RFC 8628 §3.5: slow_down adds 5 s to the poll interval.
SLOW_DOWN_STEP = 5

_lock = threading.Lock()
# {'access', 'refresh', 'refresh_after', 'expires_at'}: loaded from the
# row on first use, then the source of truth (renewals persist in the
# background). Access and refresh are None once signed out or expired.
_tokens = None
_issued = set()     # access tokens of this process, to recognise them in errors
_pending = None     # the device sign-in in progress
_refused = None     # why xAI refuses the subscription
_renew_error = None  # why the last renewal failed (it is being retried)
_renew_failures = 0
_expired = None     # why the sign-in ended on its own
# One writer, so renewals reach the database in order.
_writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix='xai-oauth')
_BILLING_RE = re.compile(r'credits|spending limit|subscription', re.I)


class _Config:
    """A config row whose xai_api_key reads as the subscription token.
    Reads like the sqlite3.Row it wraps."""

    def __init__(self, row, key):
        self._row, self._key = row, key

    def __getitem__(self, name):
        if not isinstance(name, str):
            name = self._row.keys()[name]
        return self._key if name == 'xai_api_key' else self._row[name]

    def keys(self):
        return self._row.keys()

    def __iter__(self):
        return (self[name] for name in self._row.keys())

    def __len__(self):
        return len(self._row)


def with_credentials(row):
    """`row` (a config row with a stored sign-in) with xai_api_key swapped
    for the subscription token — or `row` itself, keeping the API key,
    while the subscription can't be used and a key is saved."""
    token, usable = _access_token(row)
    if token and usable and not _refused:
        return _Config(row, token)
    if row['xai_api_key'] or not token:
        return row
    return _Config(row, token)   # no key to fall back on: xAI's own error says why


def account(config):
    """Which xAI team config['xai_api_key'] acts for: 'key' (the API
    key's console team) or 'subscription:<team id>'. Uploaded files and
    stored responses belong to a team, and the subscription's is not the
    key's (checked 2026-10-04: each side gets 404 for the other's)."""
    if isinstance(config, _Config):
        return f"subscription:{_jwt_claims(config['xai_api_key']).get('team_id') or ''}"
    return 'key'


def current_key(config):
    """config['xai_api_key'], renewed if it is a subscription token — for
    holders of a config row that can outlive the token (a voice pipeline's
    TTS and STT reconnect mid-call)."""
    if isinstance(config, _Config):
        return with_credentials(config._row)['xai_api_key']
    return config['xai_api_key']


def note_refusal(bearer, status, detail=''):
    """xAI call sites report HTTP errors here. A 403 (or a billing 429) on
    a subscription token marks the subscription refused (calls switch to
    the API key) and
    returns the message to show in its place — xAI's own is raw JSON, or
    nothing at all on a WebSocket. A 401 renews the token on its next
    read. Other keys are ignored."""
    global _refused
    if not bearer or bearer not in _issued:
        return None
    if status == 401:
        with _lock:
            if _tokens and _tokens['access'] == bearer:
                _tokens['refresh_after'] = 0
        return None
    reason = _xai_message(detail).rstrip('.')
    # Out of allowance and extra-usage credits can also come as a 429
    # ("…used all available credits or reached its monthly spending
    # limit", OpenClaw's xAI error fixtures); a plain rate limit can't.
    if not (status == 403 or (status == 429 and _BILLING_RE.search(reason))):
        return None
    if not _refused:
        _refused = f'xAI refused the subscription: {reason}'
        _logger.warning('%s', _refused)
    return (f'xAI refused your Grok subscription ({reason}). Its weekly allowance (and any extra '
            'usage credits) may be used up, or your plan may not cover this. Rexclaw uses your API key instead when one is saved '
            '(Settings → xAI connection); otherwise this works again once the allowance resets.')


def status(row):
    """Sign-in state for Settings, from the raw config row."""
    signed_in = bool(row['xai_oauth_refresh_token']) and not (_tokens and not _tokens['refresh'])
    problem = None
    if signed_in:
        usable = _tokens is None or time.time() < _tokens['expires_at']
        problem = _refused or (None if usable else _renew_error)
    return {
        'signed_in': signed_in,
        'account': row['xai_oauth_account'] if signed_in else '',
        'refused': problem,
        'expired': None if signed_in else _expired,
        'pending': _pending is not None,
    }


def usage(row):
    """The subscription's usage for Settings: {'percent' (of the period's
    allowance), 'period' ('weekly' / 'monthly' / ''), 'resets_at' (ISO),
    'prepaid_usd' (extra usage credits left), 'on_demand_used_usd',
    'on_demand_cap_usd' (auto top-up this period)}, or {'error'}."""
    token, _ = _access_token(row)
    if not token:
        return {'error': 'Not signed in.'}
    try:
        resp = requests.get(BILLING_URL, timeout=TIMEOUT,
                            headers={**HEADERS, 'Authorization': f'Bearer {token}'})
    except requests.RequestException as e:
        return {'error': f'Could not reach xAI: {e}'}
    if resp.status_code >= 400:
        return {'error': f'xAI usage is unavailable ({resp.status_code}).'}
    config = _json(resp).get('config')
    if not isinstance(config, dict):
        return {'error': 'xAI sent no usage data.'}
    period = config.get('currentPeriod') if isinstance(config.get('currentPeriod'), dict) else {}
    kind = str(period.get('type') or '')
    percent = config.get('creditUsagePercent')
    return {
        # xAI leaves zero-valued fields out (OpenClaw's usage.ts).
        'percent': percent if isinstance(percent, (int, float)) else 0,
        'period': 'weekly' if kind.endswith('WEEKLY') else 'monthly' if kind.endswith('MONTHLY') else '',
        'resets_at': period.get('end') or config.get('billingPeriodEnd'),
        'prepaid_usd': _cents(config.get('prepaidBalance')),
        'on_demand_used_usd': _cents(config.get('onDemandUsed')),
        'on_demand_cap_usd': _cents(config.get('onDemandCap')),
    }


def retry():
    """Use the subscription again after a refusal or failed renewals."""
    global _refused, _renew_failures
    with _lock:
        _refused = None
        _renew_failures = 0
        if _tokens and _tokens['refresh'] and _renew_error:
            _tokens['refresh_after'] = 0


# --- Device-code sign-in ----------------------------------------------------

def start():
    """Ask xAI for a sign-in code. Returns what Settings shows: the code,
    the page to enter it on (and the page with it filled in), and how
    often to poll."""
    global _pending
    try:
        resp = _post_form(DEVICE_URL, {'client_id': CLIENT_ID, 'scope': SCOPE, 'referrer': REFERRER})
    except requests.RequestException as e:
        raise UserError(f'Could not reach xAI: {e}')
    if resp.status_code >= 400:
        raise UserError(f'xAI sign-in could not start ({resp.status_code}): {_error_text(resp)}')
    body = _json(resp)
    if not all(body.get(k) for k in ('device_code', 'user_code', 'verification_uri')):
        raise UserError('xAI returned a sign-in response without a code.')
    url = body.get('verification_uri_complete') or body['verification_uri']
    # The page is opened in the user's browser: only ever an xAI one
    # (OpenClaw pins these the same way).
    if not all(_is_xai_url(u) for u in (url, body['verification_uri'])):
        raise UserError('xAI returned a sign-in page outside x.ai; not opening it.')
    interval = max(1, _seconds(body.get('interval'), 5))
    expires_in = _seconds(body.get('expires_in'), 300)
    _pending = {'device_code': body['device_code'], 'interval': interval,
                'deadline': time.time() + expires_in}
    return {
        'user_code': body['user_code'],
        'verification_uri': body['verification_uri'],
        'url': url,
        'interval': interval,
        'expires_in': expires_in,
    }


def poll(con):
    """One check on the sign-in in progress: {'state': 'pending'} (with the
    interval to wait), 'done' (with the account), 'error' (with a message)
    or 'idle' (nothing in progress)."""
    global _pending, _tokens, _refused, _renew_error, _renew_failures, _expired
    pending = _pending
    if not pending:
        return {'state': 'idle'}
    if time.time() > pending['deadline']:
        _pending = None
        return {'state': 'error', 'message': 'The sign-in code expired. Start again.'}
    try:
        resp = _post_form(TOKEN_URL, {'grant_type': DEVICE_GRANT, 'client_id': CLIENT_ID,
                                      'device_code': pending['device_code']})
    except requests.RequestException as e:
        _logger.warning('xAI sign-in poll failed: %s', e)
        return {'state': 'pending', 'interval': pending['interval']}
    body = _json(resp)
    if resp.status_code < 400:
        _pending = None
        if not (body.get('access_token') and body.get('refresh_token')):
            return {'state': 'error', 'message': 'xAI approved the sign-in but sent no refresh token, '
                                                 'so it could not last. Start again.'}
        account = _account(body)
        with _lock:
            _tokens = _from_response(body, None)
            _refused = _renew_error = _expired = None
            _renew_failures = 0
        con.execute('UPDATE config SET xai_oauth_access_token = ?, xai_oauth_refresh_token = ?, '
                    'xai_oauth_refresh_after = ?, xai_oauth_account = ? WHERE id = 1',
                    (_tokens['access'], _tokens['refresh'], _tokens['refresh_after'], account))
        con.commit()
        return {'state': 'done', 'account': account}
    error = body.get('error')
    if error == 'slow_down':
        pending['interval'] += SLOW_DOWN_STEP
    # No OAuth error at all: an outage, a rate limit or a Cloudflare
    # challenge page — keep waiting for the user.
    if error in ('authorization_pending', 'slow_down') or not error:
        return {'state': 'pending', 'interval': pending['interval']}
    _pending = None
    if error in ('access_denied', 'authorization_denied'):
        return {'state': 'error', 'message': 'The sign-in was declined.'}
    if error == 'expired_token':
        return {'state': 'error', 'message': 'The sign-in code expired. Start again.'}
    return {'state': 'error', 'message': f'xAI sign-in failed ({resp.status_code}): {_error_text(resp)}'}


def cancel():
    global _pending
    _pending = None


def sign_out(con):
    """Forget the sign-in (and revoke it at xAI, best effort)."""
    global _tokens, _refused, _renew_error, _expired, _pending
    row = con.execute('SELECT xai_oauth_refresh_token FROM config WHERE id = 1').fetchone()
    with _lock:
        refresh = (_tokens or {}).get('refresh') or row['xai_oauth_refresh_token']
        _tokens = _signed_out()
        _refused = _renew_error = _expired = _pending = None
    con.execute("UPDATE config SET xai_oauth_access_token = NULL, xai_oauth_refresh_token = NULL, "
                "xai_oauth_refresh_after = 0, xai_oauth_account = '' WHERE id = 1")
    con.commit()
    if refresh:
        try:
            _post_form(REVOKE_URL, {'token': refresh, 'token_type_hint': 'refresh_token',
                                    'client_id': CLIENT_ID})
        except requests.RequestException as e:
            _logger.info('xAI token revoke failed: %s', e)


# --- Tokens -----------------------------------------------------------------

def _access_token(row):
    """(token, usable): the current access token, renewed when due, and
    whether it is still within its lifetime."""
    global _tokens
    with _lock:
        if _tokens is None:
            access = row['xai_oauth_access_token']
            refresh_after = row['xai_oauth_refresh_after'] or 0
            _tokens = {'access': access, 'refresh': row['xai_oauth_refresh_token'],
                       'refresh_after': refresh_after,
                       'expires_at': _jwt_exp(access) or refresh_after}
            if access:
                _issued.add(access)
        if _tokens['refresh'] and (not _tokens['access'] or time.time() >= _tokens['refresh_after']):
            _renew_locked()
        return _tokens['access'], time.time() < _tokens['expires_at']


def _renew_locked():
    """Swap the refresh token for new tokens. xAI rotates refresh tokens,
    so only one renewal may run at a time (the caller holds _lock)."""
    global _tokens, _expired, _refused, _renew_error, _renew_failures
    old_refresh = _tokens['refresh']
    try:
        resp = _post_form(TOKEN_URL, {'grant_type': 'refresh_token', 'refresh_token': old_refresh,
                                      'client_id': CLIENT_ID})
    except requests.RequestException as e:
        # A lost response may already have used the refresh token; if so the
        # retry gets invalid_grant and the sign-in ends there.
        return _renew_later(f'Could not reach xAI to renew the sign-in: {e}')
    body = _json(resp)
    error = body.get('error')
    if resp.status_code < 400 and body.get('access_token'):
        _tokens = _from_response(body, old_refresh)
        _renew_error = None
        _renew_failures = 0
        _persist(old_refresh, _tokens['access'], _tokens['refresh'], _tokens['refresh_after'])
    elif error == 'invalid_grant':
        # Revoked, signed out elsewhere, or the refresh token was already used.
        _expired = f'Your Grok sign-in could not be renewed ({_error_text(resp)}). Sign in again.'
        _logger.warning('xAI token renewal refused (%s): %s', resp.status_code, _error_text(resp))
        _tokens = _signed_out()
        _persist(old_refresh, None, None, 0, clear_account=True)
    elif resp.status_code == 403 and error:
        # An entitlement gate, not a dead sign-in (Hermes #26847): the key
        # takes over, and renewal is tried again later or on "Try again".
        _refused = f'xAI refused the subscription when renewing it: {_error_text(resp)}'
        _logger.warning('%s', _refused)
        _renew_later(_refused)
    else:
        # 5xx, 429, a Cloudflare challenge page, or anything unexpected.
        _renew_later(f'xAI could not renew the sign-in ({resp.status_code}): {_error_text(resp)}')


def _renew_later(message):
    global _renew_error, _renew_failures
    _renew_error = message
    delay = min(RENEW_RETRY_MAX, RENEW_RETRY * 2 ** _renew_failures)
    _renew_failures += 1
    _tokens['refresh_after'] = time.time() + delay
    _logger.warning('%s (retrying in %d s)', message, delay)


def _signed_out():
    return {'access': None, 'refresh': None, 'refresh_after': math.inf, 'expires_at': 0}


def _from_response(body, old_refresh):
    access = body['access_token']
    _issued.add(access)
    lifetime = _seconds(body.get('expires_in'), 0) or max(0, (_jwt_exp(access) or 0) - time.time()) or 3600
    now = time.time()
    return {'access': access, 'refresh': body.get('refresh_token') or old_refresh,
            'refresh_after': now + lifetime - min(RENEW_EARLY, lifetime / 4),
            'expires_at': now + lifetime}


def _persist(old_refresh, access, refresh, refresh_after, clear_account=False):
    """Save a renewal off the caller's thread — it may be inside a
    transaction of its own connection, which an inline write would commit
    early or wait on. Only over the sign-in it renewed: a sign-out or a
    new sign-in that landed meanwhile is never overwritten."""
    def run():
        from .db import connect
        con = connect()
        try:
            con.execute('UPDATE config SET xai_oauth_access_token = ?, xai_oauth_refresh_token = ?, '
                        'xai_oauth_refresh_after = ? WHERE id = 1 AND xai_oauth_refresh_token IS ?',
                        (access, refresh, refresh_after, old_refresh))
            if clear_account:
                con.execute("UPDATE config SET xai_oauth_account = '' "
                            "WHERE id = 1 AND xai_oauth_refresh_token IS NULL")
            con.commit()
        except Exception:
            _logger.exception('Could not save the renewed Grok sign-in')
        finally:
            con.close()
    _writer.submit(run)


# --- Helpers ----------------------------------------------------------------

def _post_form(url, data):
    return requests.post(url, data=data, timeout=TIMEOUT, headers=HEADERS)


def _json(resp):
    try:
        body = resp.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _error_text(resp):
    body = _json(resp)
    text = body.get('error_description') or body.get('error')
    if text:
        return text
    if '<html' in resp.text[:500].lower():
        return 'xAI answered with a web page (likely a Cloudflare check) instead of OAuth JSON'
    return resp.text[:300] or f'HTTP {resp.status_code}'


def _cents(value):
    """xAI's money fields, {"val": cents} (int or digit string), in dollars."""
    raw = value.get('val') if isinstance(value, dict) else None
    try:
        return max(0, int(raw)) / 100
    except (TypeError, ValueError):
        return 0


def _xai_message(text):
    """The human part of an xAI API error body ({"code": ..., "error": ...})."""
    try:
        body = json.loads(text)
    except (TypeError, ValueError):
        body = None
    if isinstance(body, dict):
        for key in ('error', 'message', 'code'):
            value = body[key].get('message') if isinstance(body.get(key), dict) else body.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:300]
    return (text or '').strip()[:300] or 'HTTP 403'


def _is_xai_url(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    return parsed.scheme == 'https' and (host == 'x.ai' or host.endswith('.x.ai'))


def _seconds(value, default):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return default
    return value if math.isfinite(value) and value > 0 else default


def _jwt_claims(token):
    """A JWT's claims, unverified: for display and renewal timing only."""
    try:
        part = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
    except (AttributeError, IndexError, ValueError):
        return {}
    return claims if isinstance(claims, dict) else {}


def _jwt_exp(token):
    exp = _jwt_claims(token).get('exp')
    return float(exp) if isinstance(exp, (int, float)) else 0


def _account(tokens):
    """The signed-in account's email (or name), for Settings."""
    claims = _jwt_claims(tokens.get('id_token') or '')
    if not (claims.get('email') or claims.get('name')):
        try:
            resp = requests.get(USERINFO_URL, timeout=TIMEOUT,
                                headers={**HEADERS, 'Authorization': f"Bearer {tokens['access_token']}"})
            claims = _json(resp) if resp.status_code < 400 else {}
        except requests.RequestException:
            claims = {}
    return claims.get('email') or claims.get('name') or ''
