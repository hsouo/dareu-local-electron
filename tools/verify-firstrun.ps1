# tools/verify-firstrun.ps1
# 复现「全新安装首次运行」链路：空 state（无授权记录）+ 空 localStorage（无历史设备）
# 自动点击 AUTO：连接设备(requestDevice) -> 设备卡片 -> loading -> main
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$fresh = Join-Path $root 'state\fresh-run'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $root 'state\chrome-fresh'
$port = 8091
$url = "http://127.0.0.1:$port/?autoclick=1&offline=1"

if (Test-Path $fresh) { Remove-Item $fresh -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }
taskkill /IM chrome.exe /F 2>&1 | Out-Null

$env:DAREU_PORT = "$port"
$env:DAREU_DATA_DIR = $fresh
$env:DAREU_SMOKE_MS = ''
$node = (Get-Command node).Source
$psi = Start-Process -FilePath $node -ArgumentList "src\server.js" -WorkingDirectory $root -PassThru -WindowStyle Hidden
$daemonPid = $psi.Id
"daemon pid=$daemonPid url=$url"

$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try { Invoke-RestMethod "http://127.0.0.1:$port/api/state" -TimeoutSec 2 | Out-Null; $ok = $true; break } catch {}
}
"daemon ready=$ok"

$cpsi = Start-Process -FilePath $chrome -ArgumentList @(
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  ('--user-data-dir="' + $profile + '"'),
  ('--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"'),
  '--enable-logging=stderr', '--v=0', '--no-sandbox', '--disable-dev-shm-usage',
  ('"' + $url + '"')
) -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $root 'logs\firstrun-chrome.log')
"chrome pid=$($cpsi.Id)"

Start-Sleep -Seconds 45

$tr = Invoke-RestMethod "http://127.0.0.1:$port/api/trace" -TimeoutSec 6
$tr.trace | ForEach-Object { "$($_.seq) $($_.kind) $($_.msg)" } | Out-File -Encoding utf8 (Join-Path $root 'logs\firstrun-trace.log')
"trace lines=$($tr.trace.Count)"
Get-Content (Join-Path $root 'logs\firstrun-trace.log') -Encoding UTF8 | Select-String -Pattern 'verdict|AUTO|offline|autoback' | ForEach-Object { $_.Line.Substring(0,[Math]::Min(300,$_.Line.Length)) }

$st = Invoke-RestMethod "http://127.0.0.1:$port/api/state" -TimeoutSec 6
"devices=$($st.devices.Count) authorized=$($st.authorized.Count)"
$st.devices | ForEach-Object { " dev $($_.vendorId):$($_.productId) opened=$($_.opened)" }

taskkill /PID $cpsi.Id /T /F 2>&1 | Out-Null
taskkill /PID $daemonPid /T /F 2>&1 | Out-Null
'--- chrome console ---'
Get-Content (Join-Path $root 'logs\firstrun-chrome.log') -Encoding UTF8 -ErrorAction SilentlyContinue |
  Select-String -Pattern 'CONSOLE' | ForEach-Object { $_.Line } | Select-Object -First 45
