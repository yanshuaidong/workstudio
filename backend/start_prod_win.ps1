# Workstudio 后端 — Windows 生产环境启动（监听与 PID 见 backend_prod.pid）
# 用法：在 backend 目录执行
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\start_prod_win.ps1
# 监听地址与端口由仓库根目录 .env 中的 LOCAL_HOST / LOCAL_PORT 决定（默认见 config.py）。

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location -LiteralPath $Root

$pidFile = Join-Path $Root 'backend_prod.pid'
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

if (Test-Path -LiteralPath $pidFile) {
  $old = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $oldPid = 0
  if ([int]::TryParse([string]$old, [ref]$oldPid) -and $oldPid -gt 0 -and (Test-PidAlive $oldPid)) {
    Write-Host "[错误] 后端已在运行（PID $oldPid）。请先执行 stop_prod_win.ps1。" -ForegroundColor Red
    exit 1
  }
}

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) {
  Write-Host "[错误] 未找到 python，请将 Python 安装并加入 PATH。" -ForegroundColor Red
  exit 1
}

$appPy = Join-Path $Root 'app.py'
if (-not (Test-Path -LiteralPath $appPy)) {
  Write-Host "[错误] 找不到 app.py：$appPy" -ForegroundColor Red
  exit 1
}

# 若未显式设置，生产脚本默认较少控制台噪声（详见 backend/logging_setup.py）
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $py.Source
$psi.Arguments = "`"$appPy`" serve"
$psi.WorkingDirectory = $Root
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $logOut
$psi.RedirectStandardError = $logErr
$psi.CreateNoWindow = $true

foreach ($de in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
  $psi.EnvironmentVariables[[string]$de.Key] = [string]$de.Value
}
if (-not $psi.EnvironmentVariables.ContainsKey('LOG_LEVEL')) {
  $psi.EnvironmentVariables['LOG_LEVEL'] = 'WARNING'
}

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
if (-not $proc.Start()) {
  Write-Host "[错误] 无法启动后端进程。" -ForegroundColor Red
  exit 1
}

$proc.Id | Set-Content -LiteralPath $pidFile -Encoding ascii -NoNewline
Write-Host "已启动后端 PID=$($proc.Id)"
Write-Host "标准输出: $logOut"
Write-Host "错误输出: $logErr"
Write-Host ('停止请运行: powershell -NoProfile -ExecutionPolicy Bypass -File "{0}\stop_prod_win.ps1"' -f $Root)
