# Copyright 2026 Codemarchant
"""The voice pipeline's routes: the realtime-compatible call socket and the
Settings page's setup test. Connections and setups ride /api/config/get|set
(routes/misc.py)."""
import asyncio
import base64
import logging
import time

import numpy as np
from fastapi import APIRouter, Body, Depends, WebSocket

from ..db import connect, get_config
from ..errors import UserError
from ..pipeline import session as pipeline_session, setups
from ..pipeline.audio import VAD_RATE, Resampler, float_to_wav_bytes
from ..pipeline.text import strip_speech_tags
from .common import db_con

_logger = logging.getLogger(__name__)

router = APIRouter()

# The realtime client sends its token as a WebSocket subprotocol with this
# prefix (agent_connection.js), the way xAI's socket expects it.
_TOKEN_PREFIX = 'xai-client-secret.'


@router.websocket('/api/voice/pipeline')
async def pipeline_socket(ws: WebSocket):
    offered = [p.strip() for p in ws.headers.get('sec-websocket-protocol', '').split(',') if p.strip()]
    token = next((p[len(_TOKEN_PREFIX):] for p in offered if p.startswith(_TOKEN_PREFIX)), None)
    grant = pipeline_session.redeem_grant(token)
    if grant is None:
        await ws.close(code=4401)
        return
    session_id, setup_id = grant
    # The browser offered subprotocols; one must be chosen or it drops the
    # connection.
    await ws.accept(subprotocol='realtime' if 'realtime' in offered else None)
    con = connect()
    try:
        config = get_config(con)
        setup = setups.get(con, setup_id)
    finally:
        con.close()
    try:
        if setup is None:
            raise UserError('This voice setup was deleted - start the call again.')
        leg = pipeline_session.PipelineSession(ws, session_id=session_id, config=config, setup=setup,
                                               on_request=lambda tokens, brain: _record_request(session_id, tokens, brain))
    except Exception as e:
        _logger.exception('voice pipeline: could not start')
        await ws.send_json({'type': 'error', 'error': {'type': 'server_error', 'message': str(e)}})
        await ws.close(code=1011)
        return
    await leg.run()


def _record_request(session_id, tokens, brain):
    """A reply's request size, for the budget meter; once it reaches the
    brain's 'Summarise at' (setups.context_full) the session owes a
    summary, which the browser's next transcript save hears as
    needs_compaction and compacts, as for any session over budget."""
    con = connect()
    try:
        row = con.execute('SELECT context_tokens, context_floor FROM sessions WHERE id = ?',
                          (session_id,)).fetchone()
        if row is None:
            return
        # The first request after a summary (floor -1) sets the floor.
        floor = tokens if row['context_floor'] < 0 else row['context_floor']
        full = setups.context_full(brain, tokens, floor)
        con.execute('UPDATE sessions SET context_tokens = ?, context_floor = ?, '
                    'needs_summary = MAX(needs_summary, ?) WHERE id = ?',
                    (tokens, floor, 1 if full else 0, session_id))
        con.commit()
    finally:
        con.close()


@router.post('/api/voice/setups/options')
def setup_options(con=Depends(db_con)):
    """The companion editor's voice setup picker: each setup with which
    brain it runs on and what its voice is. `voice_hint` labels the
    companion's own voice field for a voice that isn't Grok's (keyed by
    `tts_connection`, see setups.pipeline_voice); on a Grok voice it is
    None and the companion's Grok voice is used. `tag_guide` is the voice
    engine's built-in speech-tag section, '' when it has none (what the
    companion wrote instead is keyed by `tts_connection` too, see
    setups.companion_tag_guide). `hosted_tools`: the provider-run tools
    (web_search, x_search, code_interpreter, mcp) its brain takes
    (LlmEngine.hosted_for)."""
    config = get_config(con)
    options = [{'value': setups.REALTIME, 'label': 'Grok Realtime', 'voice_hint': None, 'tts_connection': None,
                'brain': 'Grok Voice (realtime)', 'brain_is_xai': True, 'speech_tags': True,
                'hosted_tools': ['web_search', 'x_search', 'mcp']}]
    for row in con.execute('SELECT * FROM voice_setups ORDER BY sequence, id').fetchall():
        setup = setups.get(con, row['id'])
        llm_cls, llm_settings = setup.stages['llm']
        if setup.realtime:
            # Speech-to-speech: the call model hears and speaks, with MCP the
            # one provider-run tool it takes (`call_hosted_tools`), and no
            # speech tags; brain / hosted_tools describe the text-chat brain.
            rt_cls, rt_settings = setup.realtime
            options.append({'value': str(row['id']), 'label': row['name'],
                            'voice_hint': rt_cls.voice_hint, 'tts_connection': str(setup.realtime_connection),
                            'default_voice': rt_settings.get('voice') or '',
                            'tts_label': rt_cls.label, 'tag_guide': '',
                            'call_model': ' · '.join(filter(None, [rt_cls.label, rt_settings.get('model')])),
                            'brain': ' · '.join(filter(None, [llm_cls.label, llm_settings.get('model')])),
                            'brain_is_xai': llm_cls.uses_xai_key, 'speech_tags': False,
                            'hosted_tools': list(llm_cls.hosted_for(llm_settings)), 'call_hosted_tools': ['mcp']})
            continue
        tts_cls, tts_settings = setup.stages['tts']
        grok_voice = setup.tts_connection == setups.XAI
        options.append({'value': str(row['id']), 'label': row['name'],
                        'voice_hint': None if grok_voice else tts_cls.voice_hint,
                        'tts_connection': None if grok_voice else str(setup.tts_connection),
                        'default_voice': '' if grok_voice else tts_settings.get('voice') or '',
                        'needs_voice': not grok_voice and tts_cls.needs_voice,
                        'tts_label': tts_cls.label, 'tag_guide': tts_cls.tag_guide(tts_settings),
                        'brain': ' · '.join(filter(None, [llm_cls.label, llm_settings.get('model')])),
                        'brain_is_xai': llm_cls.uses_xai_key, 'speech_tags': bool(tts_cls.speech_tags),
                        'hosted_tools': list(llm_cls.hosted_for(llm_settings))})
    # has_xai_key: whether a Grok voice can be used at all (videos, songs)
    # by a companion whose calls speak in another engine's voice.
    return {'default': config['default_voice_setup'] or setups.REALTIME, 'options': options,
            'has_xai_key': bool(config['xai_api_key'])}


TEST_LINE = 'Hi! This is how I sound on the voice pipeline.'


@router.post('/api/voice/pipeline/test')
async def pipeline_test(payload: dict = Body(default={})):
    """Run each stage of a SAVED voice setup once and time it: the brain
    answers a one-line prompt, the voice speaks a line, and the
    transcriber hears that line back. Returns per-stage results plus the
    spoken line as WAV for the page to play."""
    con = connect()
    try:
        config = get_config(con)
        setup = setups.get(con, payload.get('setup_id'))
    finally:
        con.close()
    if setup is None:
        raise UserError('Save the setup first - the test runs the saved settings.')
    if setup.realtime:
        # Speech-to-speech: its brain answers as usual, and the provider
        # issues a call key for the model (the call itself runs in the browser).
        llm = setup.engine('llm', config)
        try:
            out = {'llm': await _test_llm(llm)}
        finally:
            await llm.close()
        out['realtime'] = await asyncio.to_thread(_test_realtime, setup.realtime)
        return out
    if setup.uses_xai_key and not config['xai_api_key']:
        raise UserError('Set your xAI API key first - an engine you chose runs on it.')
    stt, llm, tts = setup.build(config)
    out = {}
    try:
        out['llm'] = await _test_llm(llm)
        voice = setup.voice_for({'voice': 'eve', 'pipeline_voice': ''})
        tts_result, audio = await _test_tts(tts, voice)
        out['tts'] = tts_result
        out['stt'] = await _test_stt(stt, audio) if audio is not None else {
            'ok': False, 'error': 'Skipped: the voice test made no audio to transcribe.'}
        if audio is not None:
            out['audio'] = 'data:audio/wav;base64,' + base64.b64encode(
                float_to_wav_bytes(audio, VAD_RATE)).decode('ascii')
    finally:
        for engine in (stt, llm, tts):
            try:
                await engine.close()
            except Exception:
                pass
    return out


def _test_realtime(realtime):
    cls, settings = realtime
    t0 = time.perf_counter()
    try:
        minted = cls.mint(settings)
    except Exception as e:
        return {'ok': False, 'error': str(e)}
    return {'ok': True, 'text': f'Call key issued for {minted["model"]}.',
            'total_ms': round((time.perf_counter() - t0) * 1000)}


async def _test_llm(llm):
    t0 = time.perf_counter()
    first, text = None, ''
    try:
        stream = llm.stream(
            instructions='You are testing a voice connection. Reply with one short, friendly sentence.',
            items=[{'type': 'message', 'role': 'user',
                    'content': [{'type': 'input_text', 'text': 'Say hello.'}]}],
            tools=[], conversation_key='rexclaw-voice-test')
        try:
            async for ev in stream:
                if ev[0] == 'text':
                    first = first or time.perf_counter()
                    text += ev[1]
        finally:
            await stream.aclose()
    except Exception as e:
        return {'ok': False, 'error': str(e)}
    done = time.perf_counter()
    return {'ok': bool(text.strip()), 'text': strip_speech_tags(text)[:300],
            'first_ms': round(((first or done) - t0) * 1000), 'total_ms': round((done - t0) * 1000),
            **({} if text.strip() else {'error': 'The model answered with no text.'})}


async def _test_tts(tts, voice):
    t0 = time.perf_counter()
    first = None
    pieces = []
    to16k = {}

    def take(samples, rate):
        if rate not in to16k:
            to16k[rate] = Resampler(rate, VAD_RATE)
        pieces.append(to16k[rate](samples))

    try:
        async for samples, rate in tts.synthesize(TEST_LINE, voice=voice, speed=1.0, rate=24000):
            first = first or time.perf_counter()
            take(samples, rate)
    except Exception as e:
        return {'ok': False, 'error': str(e), 'voice': voice}, None
    done = time.perf_counter()
    audio = np.concatenate(pieces) if pieces else np.zeros(0, np.float32)
    if not audio.size:
        return {'ok': False, 'error': 'No audio came back.', 'voice': voice}, None
    return {'ok': True, 'voice': voice, 'first_ms': round(((first or done) - t0) * 1000),
            'total_ms': round((done - t0) * 1000), 'seconds': round(audio.size / VAD_RATE, 2)}, audio


async def _test_stt(stt, audio16k):
    t0 = time.perf_counter()
    try:
        if stt.streaming:
            stream = await stt.open_stream()
            try:
                # Real-time-ish pacing is what the engine expects; the line is
                # short, so send it in 100 ms pieces quickly, then ask for the
                # final at once instead of waiting out the silence detection.
                step = VAD_RATE // 10
                for i in range(0, audio16k.size, step):
                    await stream.push(audio16k[i:i + step])
                await stream.push(np.zeros(VAD_RATE // 2, np.float32))
                await stream.finalize()
                text = ''
                events = stream.events()
                while True:
                    kind, value = await asyncio.wait_for(events.__anext__(), 15)
                    if kind == 'final':
                        text = value
                        break
            finally:
                await stream.close()
        else:
            text = await stt.transcribe(audio16k)
    except asyncio.TimeoutError:
        return {'ok': False, 'error': 'No transcript came back within 15 s.'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}
    return {'ok': bool(text), 'text': text, 'total_ms': round((time.perf_counter() - t0) * 1000),
            **({} if text else {'error': 'The transcript was empty.'})}
