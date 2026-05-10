# Workstudio backend (FastAPI) - Windows production stop (uses backend_prod.pid)
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\stop_prod_win.ps1

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$backendPidFile = Join-Path $Root 'backend_prod.pid'

if (-not (Test-Path -LiteralPath $backendPidFile)) {
  Write-Host "INFO: PID file not found (backend_prod.pid); backend may not have been started via start_prod_win.ps1."
  exit 0
}

$raw = Get-Content -LiteralPath $backendPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
$procId = 0
if (-not ([int]::TryParse([string]$raw, [ref]$procId)) -or $procId -le 0) {
  Write-Host "INFO: invalid PID file content; removed PID file."
  Remove-Item -LiteralPath $backendPidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

try {
  $p = Get-Process -Id $procId -ErrorAction Stop
  Stop-Process -Id $procId -Force -ErrorAction Stop
  Write-Host "STOPPED backend PID=$procId (name: $($p.ProcessName))"
} catch {
  Write-Host "INFO: process PID=$procId not found or already exited."
}

Remove-Item -LiteralPath $backendPidFile -Force -ErrorAction SilentlyContinue
Write-Host "PID file removed."
