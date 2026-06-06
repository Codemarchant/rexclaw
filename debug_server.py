# Copyright 2026 Codemarchant
"""Debug entry point for IDE debuggers (PyCharm).

PyCharm's debugger monkey-patches asyncio.run with a wrapper that doesn't
accept Python 3.12's `loop_factory` keyword, which recent uvicorn versions
pass — so debugging `python -m uvicorn ...` crashes with
`TypeError: ... got an unexpected keyword argument 'loop_factory'`.

This script sidesteps the patched asyncio.run entirely by driving the server
coroutine on an explicitly-created event loop. Behaviour is otherwise
identical to `uvicorn server.main:app --port 8990`.

Usage: Run/Debug this file in PyCharm with the working directory set to the
project root. Override the port with REXCLAW_PORT.
"""
import asyncio
import os

import uvicorn


def main():
    config = uvicorn.Config(
        "server.main:app",
        host="127.0.0.1",
        port=int(os.environ.get("REXCLAW_PORT", "8990")),
    )
    server = uvicorn.Server(config)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(server.serve())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
