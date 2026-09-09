# Copyright 2026 Codemarchant
"""Exit when the process that launched us goes away.

The desktop shell (Electron) spawns this server as a child and kills it on a
normal quit. If the shell itself crashes, nothing kills the server, and the
lingering python.exe keeps the app "running" in Steam's eyes, and the user
can't relaunch until they find it in Task Manager. So the shell passes its PID in
`REXCLAW_PARENT_PID`, and a daemon thread here waits on that process and
hard-exits the moment it's gone. Nothing happens when the variable is unset
(run.sh, Docker, dev server attached to by the shell).
"""
import logging
import os
import sys
import threading
import time

_logger = logging.getLogger(__name__)

ENV_VAR = "REXCLAW_PARENT_PID"


def _wait_windows(pid: int) -> bool:
    """Block until the process exits. Returns False if it can't be watched."""
    import ctypes
    from ctypes import wintypes

    SYNCHRONIZE = 0x00100000
    INFINITE = 0xFFFFFFFF
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = wintypes.HANDLE
    handle = k32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        return False
    k32.WaitForSingleObject(handle, INFINITE)
    k32.CloseHandle(handle)
    return True


def _wait_posix(pid: int) -> bool:
    # We're the direct child, so getppid() flips to 1 (or a subreaper) once
    # the parent is gone. Signal 0 is a liveness probe, not a kill.
    while True:
        if os.getppid() != pid:
            return True
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            pass   # alive, just not ours to signal
        time.sleep(2)


def _watch(pid: int):
    try:
        watched = _wait_windows(pid) if sys.platform == "win32" else _wait_posix(pid)
    except Exception:   # noqa: BLE001, a broken watchdog must not take the server down
        _logger.exception("parent watchdog failed; not watching PID %s", pid)
        return
    if not watched:
        _logger.warning("parent watchdog: cannot open PID %s; not watching", pid)
        return
    _logger.info("parent process %s exited; shutting down", pid)
    # Hard exit on purpose: uvicorn's graceful shutdown waits on open
    # WebSockets that no longer have a window behind them. SQLite writes are
    # transactional, so nothing is left half-written.
    os._exit(0)


def start_if_configured():
    raw = os.environ.get(ENV_VAR)
    if not raw:
        return
    try:
        pid = int(raw)
    except ValueError:
        _logger.warning("ignoring non-numeric %s=%r", ENV_VAR, raw)
        return
    threading.Thread(target=_watch, args=(pid,), name="parent-watch", daemon=True).start()
