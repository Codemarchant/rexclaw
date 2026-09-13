# Copyright 2026 Codemarchant
"""Live-stream chat for idle events: Twitch and YouTube chat messages,
buffered server-side until a companion's chat-reading event takes them.

Call-scoped and lazy. While a live call's companion has a chat event, the
browser polls /api/live_chat/state (web/src/lib/idle_events.js); every poll
starts the readers the saved settings ask for, and they shut down on their
own a minute after the polls stop. Nothing connects otherwise.

Only unread messages are kept - a bounded pool, aged out after ten minutes -
and an event takes what it reads, so no message is answered twice.
Moderation carries over where the platform reports it: a message a Twitch
moderator deletes, or everything from a user they time out or ban (on
YouTube: ban - its API no longer reports deletions), leaves the pool before
a companion can read it.

Twitch is read anonymously over IRC - no account or token. YouTube goes
through the Data API's liveChatMessages.list with the user's own key.
"""
import logging
import random
import re
import socket
import ssl
import threading
import time
from collections import deque

import requests

_logger = logging.getLogger(__name__)

# Unread messages kept - the newest win, so a busy chat never builds a
# backlog.
_POOL_MAX = 50
# Unread messages older than ten minutes go - too stale to answer.
_MAX_AGE_S = 600
# Longer messages are skipped, not cut.
_MAX_CHARS = 300
# Readers stop this long after the last poll, so a reload or a quick call
# restart doesn't churn the connection.
_IDLE_STOP_S = 60
# A reader that failed (no such channel, stream not live, bad key) is
# retried no sooner than this - the browser polls every few seconds.
_RETRY_S = 60


class _Fatal(Exception):
    """A reader error an immediate retry won't fix. Shown in the call as a
    warning; the reader is retried after _RETRY_S."""


def _csv(value):
    return [p.strip().lower() for p in (value or '').split(',') if p.strip()]


def twitch_channel(value):
    """'somechannel', '#somechannel' or a twitch.tv link → the channel's
    login name ('' when it can't be one)."""
    v = (value or '').strip().lower()
    v = re.sub(r'^(https?://)?(www\.|m\.)?twitch\.tv/', '', v).lstrip('#')
    v = re.split(r'[/?#]', v, maxsplit=1)[0]
    return v if re.fullmatch(r'[a-z0-9_]{1,25}', v) else ''


def youtube_video_id(value):
    """A watch, live, youtu.be or shorts link, or a bare 11-character id →
    the video id ('' when there isn't one)."""
    v = (value or '').strip()
    if re.fullmatch(r'[A-Za-z0-9_-]{11}', v):
        return v
    m = re.search(r'(?:[?&]v=|youtu\.be/|/live/|/shorts/|/embed/)([A-Za-z0-9_-]{11})', v)
    return m.group(1) if m else ''


class _Feed:
    def __init__(self):
        self.lock = threading.Lock()
        self.pool = deque(maxlen=_POOL_MAX)   # unread messages, oldest first
        self.received = 0                     # messages accepted since server start
        self.last_poll = 0.0
        self.readers = {}                     # platform -> its latest _Reader
        self.ignored = frozenset()
        self.blocked = ()

    def idle(self):
        return time.monotonic() - self.last_poll > _IDLE_STOP_S

    def touch(self, config):
        """One poll from a live call: refresh the filters and bring the
        readers in line with the saved settings."""
        self.last_poll = time.monotonic()
        self.ignored = frozenset(_csv(config['live_chat_ignored_users']))
        self.blocked = tuple(_csv(config['live_chat_blocked_words']))
        wanted = {}
        channel = twitch_channel(config['live_chat_twitch_channel'])
        if channel:
            wanted['twitch'] = (channel,)
        video = youtube_video_id(config['live_chat_youtube_video'])
        key = (config['live_chat_youtube_api_key'] or '').strip()
        if video and key:
            wanted['youtube'] = (video, key)
        now = time.monotonic()
        with self.lock:
            for platform, reader in list(self.readers.items()):
                if reader.spec != wanted.get(platform):
                    reader.halt()
                    del self.readers[platform]
                    # Another channel's unread messages aren't this stream's.
                    self._drop(lambda m: m['platform'] == platform)
            for platform, spec in wanted.items():
                reader = self.readers.get(platform)
                if reader and (reader.is_alive()
                               or (reader.status == 'error' and now - reader.ended_at < _RETRY_S)):
                    continue
                reader = _READERS[platform](self, spec)
                self.readers[platform] = reader
                reader.start()

    def add(self, platform, msg_id, user, author_id, text):
        text = ' '.join((text or '').split())
        # Empty, a wall of text, or a bot command ("!uptime").
        if not text or len(text) > _MAX_CHARS or text.startswith('!'):
            return
        if (user or '').lower() in self.ignored or (author_id or '').lower() in self.ignored:
            return
        lowered = text.lower()
        if any(word in lowered for word in self.blocked):
            return
        with self.lock:
            self.pool.append({
                'id': msg_id or '', 'platform': platform,
                'user': user or author_id or '?', 'author_id': author_id or '',
                'text': text, 'at': time.monotonic(),
            })
            self.received += 1

    def remove(self, platform, msg_id=None, author_id=None):
        """Moderation: one message, everything from one author, or (neither
        given) the platform's whole chat."""
        with self.lock:
            if msg_id:
                self._drop(lambda m: m['platform'] == platform and m['id'] == msg_id)
            elif author_id:
                self._drop(lambda m: m['platform'] == platform and m['author_id'] == author_id)
            else:
                self._drop(lambda m: m['platform'] == platform)

    def _drop(self, match):
        # Caller holds the lock.
        kept = [m for m in self.pool if not match(m)]
        self.pool.clear()
        self.pool.extend(kept)

    def _expire(self):
        # Caller holds the lock.
        cutoff = time.monotonic() - _MAX_AGE_S
        while self.pool and self.pool[0]['at'] < cutoff:
            self.pool.popleft()

    def take(self, count):
        """An idle event reads chat: the newest `count` unread messages. The
        older unread ones go with them, read or not - the companion catches
        up the way a streamer glances at chat - so the next read starts from
        fresh chat."""
        with self.lock:
            self._expire()
            picked = list(self.pool)[-max(1, count):]
            self.pool.clear()
        return [{'platform': m['platform'], 'user': m['user'], 'text': m['text']} for m in picked]

    def state(self):
        with self.lock:
            self._expire()
            return {
                'unread': len(self.pool),
                'received': self.received,
                'platforms': {p: {'status': r.status, 'error': r.error}
                              for p, r in self.readers.items()},
            }


class _Reader(threading.Thread):
    platform = ''

    def __init__(self, feed, spec):
        super().__init__(daemon=True, name=f'live-chat-{self.platform}')
        self.feed = feed
        self.spec = spec
        # Not `_stop` / `_handle`: threading.Thread keeps its own internals
        # under those names (3.13 sets `_handle` on the instance), and a
        # method of the same name here is silently shadowed.
        self._halt = threading.Event()
        self.status = 'connecting'    # connecting | live | stopped | error
        self.error = None
        self.ended_at = 0.0

    def halt(self):
        self._halt.set()

    def stopping(self):
        return self._halt.is_set() or self.feed.idle()

    def run(self):
        try:
            self.read()
            self.status, self.error = 'stopped', None
        except Exception as e:   # _Fatal, or anything unexpected: shown, retried later
            self.status = 'error'
            self.error = str(e) or e.__class__.__name__
            _logger.warning('live chat (%s) stopped: %s', self.platform, self.error)
        finally:
            self.ended_at = time.monotonic()

    def read(self):
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Twitch (IRC)
# ---------------------------------------------------------------------------

_TWITCH_HOST = 'irc.chat.twitch.tv'
_TAG_ESCAPES = {'s': ' ', ':': ';', '\\': '\\', 'r': '\r', 'n': '\n'}


def _unescape_tag(value):
    return re.sub(r'\\(.)', lambda m: _TAG_ESCAPES.get(m.group(1), m.group(1)), value)


def _parse_irc(line):
    """One IRCv3 line → (tags, prefix, command, params); the trailing
    parameter (after ' :') is the last param."""
    tags = {}
    if line.startswith('@'):
        raw, _, line = line[1:].partition(' ')
        for part in raw.split(';'):
            key, _, value = part.partition('=')
            tags[key] = _unescape_tag(value)
    prefix = ''
    if line.startswith(':'):
        prefix, _, line = line[1:].partition(' ')
    line, sep, trailing = line.partition(' :')
    params = line.split()
    command = params.pop(0) if params else ''
    if sep:
        params.append(trailing)
    return tags, prefix, command, params


class _TwitchReader(_Reader):
    """Twitch IRC, anonymously: a 'justinfan' nick is let in read-only with
    no account or token. Undocumented - Twitch's docs only cover token
    logins - but it's what tmi.js relies on for anonymous reading."""
    platform = 'twitch'

    def read(self):
        backoff = 1
        while not self.stopping():
            try:
                self._session(self.spec[0])
                return   # only returns once it's time to stop
            except OSError as e:   # network trouble: reconnect
                self.status, self.error = 'connecting', str(e) or e.__class__.__name__
                _logger.info('twitch chat: reconnecting in %ss (%s)', backoff, self.error)
            if self._halt.wait(backoff):
                return
            backoff = min(backoff * 2, 60)

    def _session(self, channel):
        raw = socket.create_connection((_TWITCH_HOST, 6697), timeout=10)
        sock = ssl.create_default_context().wrap_socket(raw, server_hostname=_TWITCH_HOST)
        try:
            sock.settimeout(1.0)   # wake every second to notice a stop

            def send(line):
                sock.sendall((line + '\r\n').encode('utf-8'))

            # tags: display names and message ids; commands: the moderation
            # events (CLEARMSG / CLEARCHAT).
            send('CAP REQ :twitch.tv/tags twitch.tv/commands')
            # tmi.js's anonymous handshake, placeholder password included
            # (it's the tmi.js author's handle). Twitch ignores it today;
            # mirroring the most-used client covers anonymous logins ever
            # starting to want one.
            send('PASS SCHMOOPIIE')
            send(f'NICK justinfan{random.randint(10000, 99999)}')
            send(f'JOIN #{channel}')
            join_deadline = time.monotonic() + 15
            buf = b''
            last_rx = time.monotonic()
            while not self.stopping():
                # Twitch confirms a JOIN within a second or two; a channel
                # name that doesn't exist gets no reply at all, not an error.
                if self.status != 'live' and time.monotonic() > join_deadline:
                    raise _Fatal(f"couldn't join #{channel} - check the channel name")
                try:
                    data = sock.recv(4096)
                except socket.timeout:
                    # Twitch PINGs about every five minutes: much longer
                    # without a byte means a dead connection.
                    if time.monotonic() - last_rx > 360:
                        raise ConnectionError('no data from Twitch for six minutes')
                    continue
                if not data:
                    raise ConnectionError('Twitch closed the connection')
                last_rx = time.monotonic()
                buf += data
                while b'\r\n' in buf:
                    line, buf = buf.split(b'\r\n', 1)
                    self._on_line(line.decode('utf-8', 'replace'), send, channel)
        finally:
            sock.close()

    def _on_line(self, line, send, channel):
        tags, prefix, command, params = _parse_irc(line)
        if command == 'PING':
            send('PONG :' + (params[-1] if params else 'tmi.twitch.tv'))
        elif command == 'RECONNECT':
            raise ConnectionError('Twitch asked for a reconnect')
        elif command == 'JOIN':
            self.status, self.error = 'live', None
        elif command == 'PRIVMSG' and len(params) >= 2:
            login = prefix.split('!', 1)[0]
            text = params[-1]
            if text.startswith('\x01ACTION ') and text.endswith('\x01'):
                text = text[8:-1]   # a /me line
            self.feed.add('twitch', tags.get('id'), tags.get('display-name') or login, login, text)
        elif command == 'CLEARMSG':
            if tags.get('target-msg-id'):
                self.feed.remove('twitch', msg_id=tags['target-msg-id'])
        elif command == 'CLEARCHAT':
            # With a user: a timeout or ban. Without: the whole chat cleared.
            if len(params) >= 2:
                self.feed.remove('twitch', author_id=params[-1].lower())
            else:
                self.feed.remove('twitch')
        elif command == 'NOTICE' and tags.get('msg-id') == 'msg_channel_suspended':
            raise _Fatal(f'#{channel} does not exist or has been suspended')


# ---------------------------------------------------------------------------
# YouTube (Data API)
# ---------------------------------------------------------------------------

_YT_API = 'https://www.googleapis.com/youtube/v3'
# Poll no faster than this even when YouTube suggests sooner (the API's
# suggested interval or 20 s, whichever is longer). Google doesn't document
# what a chat poll costs; at the widely reported 5 quota units a call, 20 s
# keeps a 4-hour stream near 3,600 of the default 10,000 daily units.
_YT_MIN_POLL_S = 20
# Readable reasons for the Data API's chat errors (anything else shows the
# API's own message).
_YT_REASONS = {
    'liveChatEnded': 'the stream has ended',
    'liveChatDisabled': 'chat is turned off for this stream',
    'liveChatNotFound': 'no live chat found for this stream',
    'quotaExceeded': "the API key has used up today's quota",
    'forbidden': "this API key can't read that chat",
}


class _YouTubeReader(_Reader):
    """The video's live chat id, then liveChatMessages.list polling from the
    page after the first - what was said before the call joined is history,
    not something to answer."""
    platform = 'youtube'

    def read(self):
        video, key = self.spec
        chat_id = self._chat_id(video, key)
        page = None
        first = True
        backoff = 5
        while not self.stopping():
            try:
                data = self._get('liveChat/messages', key, liveChatId=chat_id,
                                 part='id,snippet,authorDetails', maxResults=200,
                                 pageToken=page)
            except requests.RequestException as e:   # network, or a transient API error
                self.status, self.error = 'connecting', str(e) or e.__class__.__name__
                if self._halt.wait(backoff):
                    return
                backoff = min(backoff * 2, 120)
                continue
            backoff = 5
            self.status, self.error = 'live', None
            page = data.get('nextPageToken') or page
            if not first:
                for item in data.get('items') or []:
                    self._on_item(item)
            first = False
            if data.get('offlineAt'):
                raise _Fatal('the stream has ended')
            wait = max(_YT_MIN_POLL_S, (data.get('pollingIntervalMillis') or 0) / 1000)
            if self._halt.wait(wait):
                return

    def _chat_id(self, video, key):
        data = self._get('videos', key, part='liveStreamingDetails', id=video)
        items = data.get('items') or []
        if not items:
            raise _Fatal('no YouTube video with that link or id')
        chat_id = (items[0].get('liveStreamingDetails') or {}).get('activeLiveChatId')
        if not chat_id:
            raise _Fatal("that video isn't live right now, or its chat is off")
        return chat_id

    def _get(self, path, key, **params):
        # The key rides in a header, not the query string, so it can never
        # surface in an error message that quotes the URL.
        resp = requests.get(f'{_YT_API}/{path}',
                            params={k: v for k, v in params.items() if v is not None},
                            headers={'x-goog-api-key': key}, timeout=15)
        if resp.status_code == 200:
            return resp.json()
        try:
            err = resp.json().get('error') or {}
        except ValueError:
            err = {}
        reason = ((err.get('errors') or [{}])[0] or {}).get('reason') or ''
        message = err.get('message') or f'HTTP {resp.status_code}'
        if resp.status_code >= 500 or reason == 'rateLimitExceeded':
            raise requests.RequestException(message)
        raise _Fatal(_YT_REASONS.get(reason, message))

    def _on_item(self, item):
        snippet = item.get('snippet') or {}
        author = item.get('authorDetails') or {}
        kind = snippet.get('type')
        if kind == 'userBannedEvent':
            banned = ((snippet.get('userBannedDetails') or {})
                      .get('bannedUserDetails') or {}).get('channelId')
            if banned:
                self.feed.remove('youtube', author_id=banned.lower())
            return
        if kind == 'chatEndedEvent':
            raise _Fatal('the stream has ended')
        if kind == 'textMessageEvent':
            text = ((snippet.get('textMessageDetails') or {}).get('messageText')
                    or snippet.get('displayMessage'))
        elif kind == 'superChatEvent':
            text = (snippet.get('superChatDetails') or {}).get('userComment')
        else:
            return
        self.feed.add('youtube', item.get('id'), author.get('displayName'),
                      (author.get('channelId') or '').lower(), text)


_READERS = {'twitch': _TwitchReader, 'youtube': _YouTubeReader}

feed = _Feed()
