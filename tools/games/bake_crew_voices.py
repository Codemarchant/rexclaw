"""Record the mini-games' crew cameo lines in the crew's own Grok voices.

Reads web/public/games/lib/crew/lines.json and writes <id>.mp3 beside it for
every line that has none yet (--force re-records them all). The mp3s ship
with the app, so players need no key of their own for them.

    XAI_API_KEY=... python tools/games/bake_crew_voices.py
    python tools/games/bake_crew_voices.py --db data/rexclaw.sqlite3   # the app's key, read-only

Prints counts only, never the key.
"""
import argparse
import io
import json
import os
import sqlite3
import sys
import time
import wave
from pathlib import Path

import lameenc
import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[2]
CREW_DIR = ROOT / 'web' / 'public' / 'games' / 'lib' / 'crew'
TTS_URL = 'https://api.x.ai/v1/tts'
SR = 24000


def key_from(args):
    if os.environ.get('XAI_API_KEY'):
        return os.environ['XAI_API_KEY']
    if args.db:
        con = sqlite3.connect(f'file:{Path(args.db).resolve().as_posix()}?mode=ro', uri=True)
        row = con.execute('SELECT xai_api_key FROM config WHERE id = 1').fetchone()
        con.close()
        if row and row[0]:
            return row[0]
    sys.exit('No key: set XAI_API_KEY or pass --db <the app database>.')


def render(key, text, voice):
    payload = {'text': text, 'voice_id': voice, 'language': 'en', 'speed': 1.0,
               'output_format': {'codec': 'wav', 'sample_rate': SR}}
    for wait in (1, 3, 8, None):
        resp = requests.post(TTS_URL, headers={'Authorization': f'Bearer {key}'}, json=payload, timeout=120)
        if resp.status_code == 200 or wait is None or resp.status_code not in (429, 500, 502, 503):
            break
        time.sleep(wait)
    if resp.status_code != 200:
        raise RuntimeError(f'TTS {resp.status_code}: {resp.text[:200]}')
    with wave.open(io.BytesIO(resp.content)) as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16)
        if w.getnchannels() > 1:
            pcm = pcm.reshape(-1, w.getnchannels()).mean(axis=1).astype(np.int16)
        rate = w.getframerate()
    # Trim the silence at either end, keep a breath of it.
    loud = np.nonzero(np.abs(pcm) > 400)[0]
    if loud.size:
        pcm = pcm[max(0, loud[0] - rate // 50): loud[-1] + rate // 8]
    enc = lameenc.Encoder()
    enc.set_bit_rate(64)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    return enc.encode(pcm.tobytes()) + enc.flush()


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--db', help="read the xAI key from this Rexclaw database (read-only)")
    ap.add_argument('--force', action='store_true', help='re-record lines that already have an mp3')
    args = ap.parse_args()
    data = json.loads((CREW_DIR / 'lines.json').read_text(encoding='utf-8'))
    key = key_from(args)
    made = skipped = failed = 0
    for line in data['lines']:
        out = CREW_DIR / f'{line["id"]}.mp3'
        if out.exists() and not args.force:
            skipped += 1
            continue
        voice = data['crew'][line['who']]['voice']
        try:
            out.write_bytes(render(key, line.get('say') or line['text'], voice))
            made += 1
            print(f'  {line["id"]} ({line["who"]})')
        except Exception as e:  # noqa: BLE001 - report and carry on
            failed += 1
            print(f'  FAILED {line["id"]}: {e}')
    print(f'recorded {made}, already had {skipped}, failed {failed}')


if __name__ == '__main__':
    main()
