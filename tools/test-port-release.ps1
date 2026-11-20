param([int]$BasePort = 8082, [int]$WaitSec = 10)
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot          # repo root (this script lives in tools/)
$exe = Join-Path $root 'dist\DAREU-Driver-win32-x64\DAREU-Driver.exe'
$state = Join-Path $root 'dist\DAREU-Driver-win32-x64\dareu-state'

function Ports([string]$tag) {
  $c = Get-NetTCPConnection -LocalPort $BasePort -State Listen
  $c2 = Get-NetTCPConnection -LocalPort ($BasePort + 1) -State Listen
  Write-Output ("[{0}] port{1} owner pid={2} | port{3} owner pid={4}" -f $tag, $BasePort, (($c | Select-Object -First 1).OwningProcess -join ','), ($BasePort + 1), (($c2 | Select-Object -First 1).OwningProcess -join ','))
}

function DaemonJson([string]$tag) {
  $f = Join-Path $state 'daemon.json'
  if (Test-Path $f) {
    $j = Get-Content $f -Raw | ConvertFrom-Json
    Write-Output ("[{0}] daemon.json port={1} pid={2}" -f $tag, $j.port, $j.pid)
  } else {
    Write-Output ("[{0}] daemon.json absent" -f $tag)
  }
}

function Alive([string]$tag) {
  $p = @(Get-Process DAREU-Driver -ErrorAction SilentlyContinue)
  $script:WinProc = $p | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  Write-Output ("[{0}] DAREU-Driver procs={1} window pid={2}" -f $tag, $p.Count, $script:WinProc.Id)
}

Write-Output '=== T1: does closing the app release the port ==='
Ports 'before'
DaemonJson 'before'
# NOTE: launch through cmd so that a stray ELECTRON_RUN_AS_NODE=1 in the environment
# does not turn the exe into a plain node process (it would exit silently).
$p = Start-Process cmd -PassThru -WindowStyle Hidden -ArgumentList '/c', ('set ELECTRON_RUN_AS_NODE=&& ' + $exe)
Write-Output ("started via cmd pid={0}, waiting {1}s" -f $p.Id, $WaitSec)
Start-Sleep -Seconds $WaitSec
Ports 'after-start'
DaemonJson 'after-start'
Alive 'after-start'
$si = Invoke-RestMethod ("http://127.0.0.1:{0}/api/state" -f $BasePort) -TimeoutSec 5
if (-not $si) { $si = Invoke-RestMethod ("http://127.0.0.1:{0}/api/state" -f ($BasePort + 1)) -TimeoutSec 5 }
Write-Output ("/api/state service={0} pid={1} port={2} devices={3}" -f $si.service, $si.pid, $si.port, $si.devices.Count)
Write-Output '--- graceful window close (same as clicking X) ---'
if ($script:WinProc) { Write-Output ('CloseMainWindow -> ' + $script:WinProc.CloseMainWindow()) }
else { Write-Output 'no window found' }
Start-Sleep -Seconds 12
Ports 'after-close'
DaemonJson 'after-close'
Alive 'after-close'
Write-Output '=== T1 done ==='
