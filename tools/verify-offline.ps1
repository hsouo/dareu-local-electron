# Offline verification: block all DNS, open local driver in headless Chrome, inspect console + DOM.
# NOTE: keep this file pure ASCII - Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and chokes on CJK.
$ErrorActionPreference = 'SilentlyContinue'
Set-Location (Split-Path -Parent $PSScriptRoot)   # repo root (this script lives in tools/)
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }

$env:DAREU_PORT = '8082'
$d = Start-Process -FilePath node -ArgumentList 'src/server.js' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
try {
  $st = Invoke-RestMethod 'http://127.0.0.1:8082/api/state' -TimeoutSec 5
  "daemon pid=$($st.pid) port=$($st.port) devices=$($st.devices.Count) offline=$($st.offline)"
} catch { "daemon not up: $_" }

$ua = Join-Path $PWD 'state\headless-profile'
# Start-Process -ArgumentList 不会给含空格的元素加引号，所以带空格的开关必须自己写引号
$argList = @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$ua",
  '--enable-logging=stderr', '--v=0',
  '--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"',
  '--virtual-time-budget=15000',
  '--dump-dom',
  'http://127.0.0.1:8082/index.html?shim_no_sse=1'
)
$p = Start-Process -FilePath $chrome -ArgumentList $argList -PassThru -RedirectStandardOutput 'logs\off-dom.html' -RedirectStandardError 'logs\off-err.log'
if (-not $p.WaitForExit(90000)) { 'chrome timeout, killing'; Stop-Process -Id $p.Id -Force }
"chrome exit=$($p.ExitCode) dom=$((Get-Item 'logs\off-dom.html').Length)B err=$((Get-Item 'logs\off-err.log').Length)B"

Select-String -Path 'logs\off-err.log' -Pattern 'CONSOLE' | ForEach-Object { $_.Line } | Out-File -Encoding utf8 'logs\off-console.log'
'--- console ---'
Get-Content 'logs\off-console.log' -Encoding UTF8 | Out-String -Width 200
'--- iframe in DOM ---'
Get-Content 'logs\off-dom.html' -Encoding UTF8 | Select-String -Pattern 'iframe' -SimpleMatch | ForEach-Object { $_.Line.Trim() } | Out-String -Width 200

node src/cli.js stop 2>&1 | Out-String
