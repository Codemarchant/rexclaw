@echo off
rem One-command start for Rexclaw Companions (Windows).
rem
rem   run.bat
rem
rem First run: creates the Python venv, installs backend deps, and builds the
rem frontend. Subsequent runs skip straight to launch - the frontend is only
rem rebuilt when web\ sources are newer than the built web\dist (e.g. after
rem a `git pull`).
setlocal
cd /d "%~dp0"

if "%REXCLAW_PORT%"=="" (set PORT=8990) else (set PORT=%REXCLAW_PORT%)
set PY=.venv\Scripts\python.exe

rem ---- Python venv + backend deps ------------------------------------------
"%PY%" -c "import fastapi, uvicorn, requests" >nul 2>&1
if errorlevel 1 (
    echo [rexclaw] setting up Python environment...
    if exist .venv rmdir /s /q .venv
    where py >nul 2>&1 && (py -3 -m venv .venv) || (python -m venv .venv)
    if not exist "%PY%" (
        echo [rexclaw] venv creation failed - install Python 3.10+ from python.org
        exit /b 1
    )
    "%PY%" -m pip install --quiet --upgrade pip
    "%PY%" -m pip install --quiet -e .
)

rem ---- Frontend build (missing OR stale web\dist) -----------------------------
rem A `git pull` updates web\ sources but leaves the previously-built web\dist
rem in place, silently serving the old UI. Rebuild whenever any frontend
rem source is newer than the built index.html.
set NEED_BUILD=0
if not exist web\dist\index.html (
    set NEED_BUILD=1
) else (
    powershell -NoProfile -Command "$d=(Get-Item 'web/dist/index.html').LastWriteTime; if (Get-ChildItem 'web/src','web/public','web/index.html','web/package.json','web/vite.config.js' -Recurse -File | Where-Object { $_.LastWriteTime -gt $d } | Select-Object -First 1) { exit 1 }" >nul 2>&1
    if errorlevel 1 set NEED_BUILD=1
)
if "%NEED_BUILD%"=="1" (
    where npm >nul 2>&1
    if errorlevel 1 (
        if exist web\dist\index.html (
            rem Stale but present: degrade gracefully - an outdated UI beats
            rem refusing to start on a machine that no longer has Node.
            echo [rexclaw] web\ sources changed but npm is not installed - serving the previous build.
        ) else (
            echo [rexclaw] web\dist\ is missing and npm is not installed.
            echo           Install Node.js from https://nodejs.org, then re-run run.bat
            exit /b 1
        )
    ) else (
        echo [rexclaw] building frontend...
        rem npm install also picks up dependencies a pull may have added;
        rem it is fast when node_modules is already up to date.
        cd web && call npm install --no-fund --no-audit && call npm run build && cd ..
    )
)

rem ---- Launch -----------------------------------------------------------------
echo [rexclaw] starting at http://localhost:%PORT%  (Ctrl+C to stop)
start "" "http://localhost:%PORT%"
"%PY%" -m uvicorn server.main:app --port %PORT%
