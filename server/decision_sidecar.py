# Copyright 2026 Codemarchant
"""The local decision model's process: Valen-Decision behind
`POST /v1/systemone` and `GET /health` on a 127.0.0.1 port, exiting when
the Rexclaw server that started it goes away.

Run by the interpreter decision_local.py installs under data/decision/,
never by the Rexclaw server's own: this file imports nothing from the
server package.

The model is loaded with transformers from its folder, which carries the
model's own code. Requests arrive exactly as jev.py sends them to TypeSafe
(images as `assets` the state refers to, `box` questions) and are put into
Valen's shape (images as message parts, `bbox` questions) and back, so the
server side has one wire format.
"""
import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _alive(pid):
    try:
        if os.name == 'nt':
            import ctypes
            h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if not h:
                return False
            code = ctypes.c_ulong()
            ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(h)
            return code.value == 259  # STILL_ACTIVE
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _watch(pid):
    while True:
        time.sleep(3)
        if not _alive(pid):
            os._exit(0)


class Busy(Exception):
    """The model was still answering others when this caller's wait ran out."""


class Valen:
    def __init__(self, folder, name, device):
        import torch
        from transformers import AutoModel, AutoProcessor
        self.name = name
        # The model card's loading recipe.
        self.model = AutoModel.from_pretrained(folder, trust_remote_code=True, dtype='auto',
                                               attn_implementation='sdpa').to(device).eval()
        torch.set_float32_matmul_precision('highest')
        torch.backends.cudnn.allow_tf32 = False
        self.processor = AutoProcessor.from_pretrained(folder, trust_remote_code=True)
        # Valen refuses text holding one of the tokenizer's control tokens;
        # a line that happens to contain one is defused instead.
        self.specials = sorted(self.processor.tokenizer.all_special_tokens, key=len, reverse=True)
        self.lock = threading.Lock()  # one forward pass at a time
        self.ask({'state': 'Hello there!',
                  'questions': {'q': {'type': 'noul', 'instructions': 'Is this a greeting?'}}})

    def _text(self, value):
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        for token in self.specials:
            if token in text:
                text = text.replace(token, token.replace('<', '＜').replace('>', '＞'))
        return text

    def ask(self, body, wait=None):
        """`wait`: how many seconds the caller will wait for its answer.
        A request still queued behind others when that has passed is
        dropped (Busy) rather than run for nobody: otherwise one slow
        stretch leaves a queue of abandoned questions in front of every
        new one."""
        assets = body.get('assets') or {}
        text = self._text(body['state'])
        content = []
        for n, (ref, asset) in enumerate(assets.items(), 1):
            # The state names its image by a reference string; here the
            # images are numbered parts of the message.
            text = text.replace(ref, f'Image {n}')
            fmt = 'jpeg' if asset.get('format') in ('jpg', 'jpeg') else asset.get('format')
            content.append({'type': 'image_url',
                            'image_url': {'url': f'data:image/{fmt};base64,{asset["data_base64"]}'}})
        state = {'messages': [{'role': 'user', 'content': content + [{'type': 'text', 'text': text}]}]} \
            if content else text
        questions = {}
        for qid, q in body['questions'].items():
            item = {'type': 'bbox' if q['type'] == 'box' else q['type'],
                    'instructions': self._text(q['instructions'])}
            if item['type'] == 'bbox':
                item['image'] = 0
            elif isinstance(q.get('criteria'), dict):
                item['criteria'] = {k: self._text(v) for k, v in q['criteria'].items()}
            elif isinstance(q.get('criteria'), list):
                item['criteria'] = [self._text(v) for v in q['criteria']]
            questions[qid] = item
        if not self.lock.acquire(timeout=wait if wait and wait > 0 else -1):
            raise Busy()
        try:
            out = self.model.predict({'state': state, 'questions': questions}, processor=self.processor)
        finally:
            self.lock.release()
        answers = {}
        for qid, a in out['answers'].items():
            if a.get('type') == 'bbox':
                left, top, right, bottom = a['bbox']
                a = {'type': 'box', 'confidence': a['confidence'],
                     'box': {'left': left, 'top': top, 'right': right, 'bottom': bottom}}
            answers[qid] = a
        return {'model': self.name, 'answers': answers, 'usage': out.get('usage')}


def serve(args):
    valen = Valen(args.model, args.name, args.device)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *a):
            pass

        def _send(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == '/health':
                self._send(200, {'status': 'ok', 'model': valen.name, 'device': args.device})
            else:
                self._send(404, {'error': 'not found'})

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)))
            except ValueError:
                return self._send(400, {'error': 'The request body is not JSON.'})
            if self.path != '/v1/systemone':
                return self._send(404, {'error': 'not found'})
            try:
                wait = float(self.headers.get('X-Rexclaw-Wait') or 0)
            except ValueError:
                wait = 0
            try:
                self._send(200, valen.ask(body, wait))
            except Busy:
                self._send(503, {'error': 'Busy with earlier questions.'})
            except (ConnectionError, BrokenPipeError):
                pass  # the caller stopped waiting
            except (ValueError, KeyError, TypeError) as e:
                self._send(400, {'error': str(e)[:300]})
            except Exception as e:  # noqa: BLE001 — out of memory and the like
                print(f'request failed: {type(e).__name__}: {e}', flush=True)
                self._send(500, {'error': f'{type(e).__name__}: {str(e)[:300]}'})

    print(f'{valen.name} on 127.0.0.1:{args.port} ({args.device})', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--name', default='')
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--parent-pid', type=int)
    args = parser.parse_args()
    if args.parent_pid:
        threading.Thread(target=_watch, args=(args.parent_pid,), daemon=True).start()
    serve(args)


if __name__ == '__main__':
    main()
