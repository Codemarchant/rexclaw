# Builds the embedded Python runtime for the packaged desktop app (Windows).
#
#     powershell -ExecutionPolicy Bypass -File build-runtime.ps1
#
# Output: desktop/runtime/python/ — a self-contained interpreter with the
# server dependencies installed. electron-builder ships it as resources/python
# (see extraResources in package.json) and main.js resolvePython() finds it
# there at run time. Re-run whenever pyproject.toml dependencies change.
#
# Run this on Windows (or a windows-latest CI runner): the wheels it installs
# must be win_amd64, so building from WSL/Linux would produce a broken bundle.
param(
    # Keep in sync with the interpreter the project is developed against.
    [string]$PythonVersion = "3.12.8"
)
$ErrorActionPreference = "Stop"

$Desktop  = $PSScriptRoot
$RepoRoot = Split-Path $Desktop -Parent
$Runtime  = Join-Path $Desktop "runtime"
$PyDir    = Join-Path $Runtime "python"
$PyExe    = Join-Path $PyDir "python.exe"

# --- 1. Fetch + extract the official embeddable package ----------------------
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
if (Test-Path $PyDir) { Remove-Item -Recurse -Force $PyDir }
$zip = Join-Path $Runtime "python-embed.zip"
$url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
Write-Host "[runtime] downloading $url"
Invoke-WebRequest $url -OutFile $zip
Expand-Archive $zip -DestinationPath $PyDir
Remove-Item $zip

# --- 2. Rewrite the ._pth ----------------------------------------------------
# A ._pth file REPLACES sys.path entirely and enables isolated mode (PYTHONPATH
# is ignored), so every import root must be listed explicitly:
#   Lib\site-packages — where pip installs the server dependencies
#   ..\app-server     — the bundled server source in the packaged layout
#                       (resources/python next to resources/app-server; the
#                       path simply doesn't exist at build time, which is fine)
$pth  = Get-ChildItem $PyDir -Filter "python3*._pth" | Select-Object -First 1
$stem = [IO.Path]::GetFileNameWithoutExtension($pth.Name)
@(
    "$stem.zip"
    "."
    "Lib\site-packages"
    "..\app-server"
    "import site"
) | Set-Content $pth.FullName -Encoding ascii
Write-Host "[runtime] wrote $($pth.Name)"

# --- 3. Bootstrap pip inside the embedded interpreter ------------------------
$getpip = Join-Path $Runtime "get-pip.py"
Invoke-WebRequest "https://bootstrap.pypa.io/get-pip.py" -OutFile $getpip
& $PyExe $getpip --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "get-pip failed" }
Remove-Item $getpip

# --- 4. Install the server dependencies (NOT the project itself) -------------
# The server runs from the bundled source tree so its Path(__file__)-relative
# assets/web-dist lookups resolve; only third-party deps go to site-packages.
$reqs = Join-Path $Runtime "requirements.txt"
& $PyExe -c "import tomllib; deps = tomllib.load(open(r'$RepoRoot\pyproject.toml', 'rb'))['project']['dependencies']; open(r'$reqs', 'w').write('\n'.join(deps))"
if ($LASTEXITCODE -ne 0) { throw "reading pyproject dependencies failed" }
Write-Host "[runtime] installing:" (Get-Content $reqs)
& $PyExe -m pip install -r $reqs --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
Remove-Item $reqs

# --- 5. Slim + smoke test ----------------------------------------------------
Get-ChildItem $PyDir -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force
& $PyExe -c "import fastapi, uvicorn, requests, multipart; print('[runtime] import smoke test OK')"
if ($LASTEXITCODE -ne 0) { throw "smoke test failed" }

$size = [math]::Round((Get-ChildItem $PyDir -Recurse | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "[runtime] done: $PyDir ($size MB)"
Write-Host "[runtime] next: npm run dist  (packages shell + server + this runtime)"
