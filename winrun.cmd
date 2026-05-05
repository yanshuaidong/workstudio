@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "PYSCRIPT=%~dp0backend\app.py"
set "PREFLIGHT=%~dp0backend\preflight.py"
set "HOST=127.0.0.1"
set "PORT=17890"
set "FOUND_PYTHON=0"

if not exist "%PYSCRIPT%" (
    echo winrun.cmd: backend server script not found: "%PYSCRIPT%" 1>&2
    exit /b 1
)

if not exist "%PREFLIGHT%" (
    echo winrun.cmd: backend preflight script not found: "%PREFLIGHT%" 1>&2
    exit /b 1
)

call :try_python py -3
if not errorlevel 1 goto run_server

call :try_python python
if not errorlevel 1 goto run_server

call :try_python python3
if not errorlevel 1 goto run_server

if "%FOUND_PYTHON%"=="0" (
    echo winrun.cmd: Python was not found. Please install Python and add it to PATH. 1>&2
) else (
    echo winrun.cmd: no usable Python environment found. Required package missing: pymysql 1>&2
)
exit /b 1

:try_python
%* --version >nul 2>nul
if errorlevel 1 exit /b 1
set "FOUND_PYTHON=1"

%* -c "import pymysql" >nul 2>nul
if errorlevel 1 (
    echo winrun.cmd: skipping %*: pymysql is not installed in this Python environment.
    echo winrun.cmd: install it with: %* -m pip install pymysql
    exit /b 1
)

set "PYTHON_CMD=%*"
exit /b 0

:run_server
echo Running startup checks: %PYTHON_CMD% "%PREFLIGHT%" --host %HOST% --port %PORT%
%PYTHON_CMD% "%PREFLIGHT%" --host %HOST% --port %PORT%
if errorlevel 1 (
    echo winrun.cmd: startup checks failed. Backend was not started. 1>&2
    exit /b 1
)

echo Starting backend: %PYTHON_CMD% "%PYSCRIPT%" serve --host %HOST% --port %PORT%
%PYTHON_CMD% -u "%PYSCRIPT%" serve --host %HOST% --port %PORT%
exit /b %ERRORLEVEL%
