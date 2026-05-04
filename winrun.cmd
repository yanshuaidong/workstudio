@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "PYSCRIPT=%~dp0backend\clist_local_server.py"
set "HOST=127.0.0.1"
set "PORT=17890"

if not exist "%PYSCRIPT%" (
    echo winrun.cmd: backend server script not found: "%PYSCRIPT%" 1>&2
    exit /b 1
)

py -3 --version >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
    goto run_server
)

python --version >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python"
    goto run_server
)

python3 --version >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python3"
    goto run_server
)

echo winrun.cmd: Python was not found. Please install Python and add it to PATH. 1>&2
exit /b 1

:run_server
echo Starting backend: %PYTHON_CMD% "%PYSCRIPT%" serve --host %HOST% --port %PORT%
%PYTHON_CMD% "%PYSCRIPT%" serve --host %HOST% --port %PORT%
exit /b %ERRORLEVEL%
