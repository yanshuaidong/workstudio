# Workstudio backend (FastAPI) - Windows production start (PID in backend_prod.pid)
# Run from backend directory:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\start_prod_win.ps1
# Steps: env check -> (optional) pip install -> import check -> app/main.py -> uvicorn
# Listen: BACKEND_HOST / BACKEND_PORT; else repo-root .env; default 127.0.0.1:8000
# Skip pip: $env:SKIP_BACKEND_DEPS = "1"

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location -LiteralPath $Root

$RepoRoot = Split-Path -Parent $Root

function Import-RepoDotEnv {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    $v = $t.Substring($eq + 1).Trim()
    if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    if (-not $k) {
      continue
    }
    $procEnv = [Environment]::GetEnvironmentVariables('Process')
    if ($procEnv.ContainsKey($k)) {
      continue
    }
    [Environment]::SetEnvironmentVariable($k, $v, 'Process')
  }
}

function Get-BackendPython {
  $venvPy = Join-Path $Root '.venv\Scripts\python.exe'
  if (Test-Path -LiteralPath $venvPy) {
    return $venvPy
  }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  return $null
}

function Invoke-Py {
  param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string[]]$ArgumentList
  )
  $p = Start-Process -FilePath $Exe -ArgumentList $ArgumentList -WorkingDirectory $Root -Wait -PassThru -NoNewWindow
  if ($null -eq $p -or $p.ExitCode -ne 0) {
    $code = if ($null -eq $p) { -1 } else { $p.ExitCode }
    Write-Host "ERROR: child process exited with code $code" -ForegroundColor Red
    exit $code
  }
}

function Test-PythonVersionOk {
  param([Parameter(Mandatory)][string]$Exe)
  $out = & $Exe -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: failed to run Python: $out" -ForegroundColor Red
    exit 1
  }
  $parts = ([string]$out).Trim() -split '\.'
  $maj = 0; $min = 0
  if (-not [int]::TryParse($parts[0], [ref]$maj) -or -not [int]::TryParse($parts[1], [ref]$min)) {
    Write-Host "ERROR: cannot parse Python version: $out" -ForegroundColor Red
    exit 1
  }
  if ($maj -lt 3 -or ($maj -eq 3 -and $min -lt 10)) {
    Write-Host "ERROR: Python 3.10+ required, got $out" -ForegroundColor Red
    exit 1
  }
}

function Install-Dependencies {
  param([Parameter(Mandatory)][string]$Exe)
  $req = Join-Path $Root 'requirements.txt'
  $proj = Join-Path $Root 'pyproject.toml'
  if (Test-Path -LiteralPath $req) {
    Write-Host "DEPS: pip install -r requirements.txt ..."
    Invoke-Py -Exe $Exe -ArgumentList @(
      '-m', 'pip', 'install', '--disable-pip-version-check', '-r', $req
    )
  } elseif (Test-Path -LiteralPath $proj) {
    Write-Host "DEPS: pip install -e . (pyproject.toml) ..."
    Invoke-Py -Exe $Exe -ArgumentList @(
      '-m', 'pip', 'install', '--disable-pip-version-check', '-e', $Root
    )
  } else {
    Write-Host "ERROR: neither backend/requirements.txt nor pyproject.toml found; cannot install dependencies." -ForegroundColor Red
    exit 1
  }
}

function Test-RuntimeImports {
  param([Parameter(Mandatory)][string]$Exe)
  $err = & $Exe -c 'import uvicorn, fastapi' 2>&1
  if ($LASTEXITCODE -ne 0) {
    if ($err) {
      Write-Host $err
    }
    Write-Host "ERROR: import uvicorn / fastapi failed; check pip, network, and permissions." -ForegroundColor Red
    exit 1
  }
}

Import-RepoDotEnv (Join-Path $RepoRoot '.env')

$bindHost = [Environment]::GetEnvironmentVariable('BACKEND_HOST', 'Process')
if ([string]::IsNullOrWhiteSpace($bindHost)) {
  $bindHost = '127.0.0.1'
}

$bindPort = [Environment]::GetEnvironmentVariable('BACKEND_PORT', 'Process')
if ([string]::IsNullOrWhiteSpace($bindPort)) {
  $bindPort = '8000'
}

$backendPidFile = Join-Path $Root 'backend_prod.pid'
$logDir = Join-Path $Root 'logs'
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$logOut = Join-Path $logDir "backend_$stamp.out.log"
$logErr = Join-Path $logDir "backend_$stamp.err.log"

function Test-PidAlive([int]$ProcId) {
  try {
    $p = Get-Process -Id $ProcId -ErrorAction Stop
    return $null -ne $p
  } catch {
    return $false
  }
}

if (Test-Path -LiteralPath $backendPidFile) {
  $old = Get-Content -LiteralPath $backendPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $oldPid = 0
  if ([int]::TryParse([string]$old, [ref]$oldPid) -and $oldPid -gt 0 -and (Test-PidAlive $oldPid)) {
    Write-Host "ERROR: backend already running (PID $oldPid). Run stop_prod_win.ps1 first." -ForegroundColor Red
    exit 1
  }
}

Write-Host "ENV: resolving Python ..."
$pyExe = Get-BackendPython
if (-not $pyExe) {
  Write-Host "ERROR: Python not found. Create backend\.venv or add Python to PATH." -ForegroundColor Red
  exit 1
}
Write-Host "     using: $pyExe"

Write-Host "ENV: checking Python version (need 3.10+) ..."
Test-PythonVersionOk -Exe $pyExe

Write-Host "ENV: checking pip ..."
$t = & $pyExe -m pip --version 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: python -m pip failed: $t" -ForegroundColor Red
  exit 1
}

$skipDeps = [Environment]::GetEnvironmentVariable('SKIP_BACKEND_DEPS', 'Process')
if ($skipDeps -eq '1') {
  Write-Host "DEPS: SKIP_BACKEND_DEPS=1, skipping pip install."
} else {
  Install-Dependencies -Exe $pyExe
}

Write-Host "CHECK: import uvicorn / fastapi ..."
Test-RuntimeImports -Exe $pyExe

$mainPy = Join-Path $Root 'app\main.py'
if (-not (Test-Path -LiteralPath $mainPy)) {
  Write-Host "ERROR: FastAPI entry not found: $mainPy (create app/main.py under backend/ per architecture doc)." -ForegroundColor Red
  exit 1
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $pyExe
$psi.Arguments = ('-m uvicorn app.main:app --host {0} --port {1}' -f $bindHost, $bindPort)
$psi.WorkingDirectory = $Root
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $logOut
$psi.RedirectStandardError = $logErr
$psi.CreateNoWindow = $true

foreach ($de in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
  $keyName = [string]$de.Key
  $psi.EnvironmentVariables[$keyName] = [string]$de.Value
}
if (-not $psi.EnvironmentVariables.ContainsKey('LOG_LEVEL')) {
  $psi.EnvironmentVariables['LOG_LEVEL'] = 'WARNING'
}

$uvicornProc = New-Object System.Diagnostics.Process
$uvicornProc.StartInfo = $psi
if (-not $uvicornProc.Start()) {
  Write-Host "ERROR: failed to start backend process." -ForegroundColor Red
  exit 1
}

$uvicornProc.Id | Set-Content -LiteralPath $backendPidFile -Encoding ascii -NoNewline
Write-Host ('STARTED backend PID={0} at {1}:{2}' -f $uvicornProc.Id, $bindHost, $bindPort)
Write-Host "stdout log: $logOut"
Write-Host "stderr log: $logErr"
$dq = [char]34
Write-Host ('To stop: powershell -NoProfile -ExecutionPolicy Bypass -File ' + $dq + $Root + '\stop_prod_win.ps1' + $dq)
