# Workstudio 后端 — Windows 生产环境停止（依据 backend_prod.pid）
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\stop_prod_win.ps1

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$pidFile = Join-Path $Root 'backend_prod.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "[提示] 未找到 PID 文件（backend_prod.pid），可能未通过 start_prod_win.ps1 启动。"
  exit 0
}

$raw = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
$procId = 0
if (-not ([int]::TryParse([string]$raw, [ref]$procId)) -or $procId -le 0) {
  Write-Host "[提示] PID 文件内容无效，已删除 PID 文件。"
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

try {
  $p = Get-Process -Id $procId -ErrorAction Stop
  Stop-Process -Id $procId -Force -ErrorAction Stop
  Write-Host "已停止后端进程 PID=$procId （名称: $($p.ProcessName)）"
} catch {
  Write-Host "[提示] 进程 PID=$procId 不存在或已退出。"
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "已清除 PID 文件。"
