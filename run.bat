@echo off
rem One-command start for Rexclaw Companions (Windows).
rem
rem   run.bat
rem
rem First run: creates the Python venv, installs backend deps, and builds the
rem frontend if web\dist\ is missing. Subsequent runs skip straight to launch.
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

rem ---- Frontend build (only when web\dist is missing) ------------------------
if not exist web\dist\index.html (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo [rexclaw] web\dist\ is missing and npm is not installed.
        echo           Install Node.js from https://nodejs.org, then re-run run.bat
        exit /b 1
    )
    echo [rexclaw] building frontend ^(first run only^)...
    if not exist web\node_modules (cd web && call npm install --no-fund --no-audit && cd ..)
    cd web && call npm run build && cd ..
)

rem ---- Launch -----------------------------------------------------------------
echo [rexclaw] starting at http://localhost:%PORT%  (Ctrl+C to stop)
start "" "http://localhost:%PORT%"
"%PY%" -m uvicorn server.main:app --port %PORT%
