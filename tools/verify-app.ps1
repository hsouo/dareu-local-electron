# End-to-end app flow check with a REAL (headless but normal) Chrome:
#  - keeps SSE alive (device input reports need it) -- no --dump-dom, because --dump-dom waits for the
#    load event and freezes the renderer while an EventSource is pending (verified: page JS stops).
#  - the page-side auto mode (offline-stub.js, ?autoclick=1) clicks the first device card and POSTs the
#    verdict to /api/event-log, so the result is read from the daemon trace instead of the DOM dump.
# NOTE: pure ASCII - Windows PowerShell 5.1 misreads BOM-less UTF-8 .ps1 files.
param(
  [int]$Port = 8082,
  [int]$WaitSec = 30,
  [string]$Url = '',
  [string]$Profile = 'headless-profile',
  [switch]$NoDaemon
)
$ErrorActionPreference = 'SilentlyContinue'
Set-Location (Split-Path -Parent $PSScriptRoot)   # repo root (this script lives in tools/)
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
if ($Url -eq '') { $Url = "http://127.0.0.1:$Port/index.html?offline=1&watchdog=1&autoclick=1" }
'URL ' + $Url

$daemon = $null
if (-not $NoDaemon) {
  $env:DAREU_PORT = "$Port"
  $daemon = Start-Process -FilePath node -ArgumentList 'src/server.js' -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
}
try {
  $st = Invoke-RestMethod "http://127.0.0.1:$Port/api/state" -TimeoutSec 5
  "daemon pid=$($st.pid) port=$($st.port) devices=$($st.devices.Count)"
} catch { "daemon not up: $_"; exit 1 }

$tr0 = Invoke-RestMethod "http://127.0.0.1:$Port/api/trace" -TimeoutSec 5
$seqBefore = 0
if ($tr0.trace -and $tr0.trace.Count -gt 0) { $seqBefore = [int]($tr0.trace | Select-Object -Last 1).seq }
$ua = Join-Path $PWD "state\$Profile"
$t0 = Get-Date
$argList = @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  "--user-data-dir=$ua",
  '--enable-logging=stderr', '--v=0',
  '--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"',
  $Url
)
$p = Start-Process -FilePath $chrome -ArgumentList $argList -PassThru -RedirectStandardError 'logs\app-err.log'
"chrome pid=$($p.Id) waiting ${WaitSec}s ..."
Start-Sleep -Seconds $WaitSec

$tr = Invoke-RestMethod "http://127.0.0.1:$Port/api/trace" -TimeoutSec 5
'--- console ---'
Select-String -Path 'logs\app-err.log' -Pattern 'CONSOLE' | ForEach-Object { $_.Line -replace '^.*INFO:CONSOLE', 'CONSOLE' } | Out-String -Width 220
'--- verdict ---'
$auto = $tr.trace | Where-Object { $_.seq -gt $seqBefore -and $_.kind -eq 'auto' }
if ($auto) { $auto | ForEach-Object { $_.msg } | Out-String -Width 400 } else { 'no auto verdict (页面没跑到 20s 或被冻住)' }
"--- trace since $seqBefore ---"
$tr.trace | Where-Object { $_.seq -gt $seqBefore } | ForEach-Object { "$($_.seq) $($_.kind) $($_.msg)" } | Out-String -Width 220

# 只杀我们起的这棵 chrome 进程树（taskkill 不需要 WMI；CIM/Get-CimInstance 在沙箱里会卡死）
& taskkill /T /F /PID $p.Id 2>&1 | Out-Null
Start-Sleep -Milliseconds 400
if (-not $NoDaemon) { node src/cli.js stop 2>&1 | Out-String }
'done'
