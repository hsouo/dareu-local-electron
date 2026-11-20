# Create/refresh a GitHub Release and upload the dist zip + checksums.
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release.ps1 [-Repo owner/name] [-Proxy http://127.0.0.1:10808]
#
# Token comes from git's own credential store (git credential fill), nothing is hardcoded.
# NOTE: curl 8.x on Windows got HTTP 400 ("Whoa there!") from uploads.github.com here,
#       Invoke-RestMethod -InFile with Expect100Continue disabled works. Keep this shape.
param(
  [string]$Repo = 'hsouo/dareu-local-electron',
  [string]$Tag = '',
  [string]$Proxy = 'http://127.0.0.1:10808',
  [string]$Arch = 'win32-x64',
  [switch]$SkipZip
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ---------- token ----------
$inp = "protocol=https`nhost=github.com`n`n"
$credText = $inp | git credential fill | Out-String
$token = ($credText -split "`n" | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { throw 'no github token from git credential fill' }

# ---------- version / tag ----------
if ($Tag -eq '') {
  $raw = [IO.File]::ReadAllText((Join-Path $root 'package.json'))
  if ($raw -match '"version"\s*:\s*"([^"]+)"') { $Tag = 'v' + $Matches[1] } else { throw 'cannot read version' }
}
$version = $Tag -replace '^v', ''

# ---------- zip ----------
if (-not $SkipZip) {
  & (Join-Path $PSScriptRoot 'zip-dist.ps1') -Version $version -Arch $Arch | Write-Output
}
$zipName = "DAREU-Driver-$Arch-v$version.zip"
$zipPath = Join-Path $root "release\$zipName"
if (-not (Test-Path $zipPath)) { throw "missing $zipPath" }
$sumPath = "$zipPath.sha256"

# ---------- release ----------
$api = 'https://api.github.com'
$h = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'dareu-release' }
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'dareu-release' }

$existing = $null
try { $existing = Invoke-RestMethod -Uri "$api/repos/$Repo/releases/tags/$Tag" -Headers $h -Proxy $Proxy -TimeoutSec 40 } catch { }
if ($existing) {
  Write-Output ("release exists: id={0} {1}" -f $existing.id, $existing.html_url)
  $rel = $existing
} else {
  $body = "See CHANGELOG.md. Portable win32-x64 build: unzip to a writable folder, run DAREU-Driver.exe."
  $payload = @{ tag_name = $Tag; name = "$Tag"; body = $body; draft = $false; prerelease = $false } | ConvertTo-Json
  $rel = Invoke-RestMethod -Uri "$api/repos/$Repo/releases" -Method Post -Headers $h -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -Proxy $Proxy -TimeoutSec 60
  Write-Output ("release created: {0}" -f $rel.html_url)
}

# ---------- upload ----------
[Net.ServicePointManager]::Expect100Continue = $false
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$upBase = "https://uploads.github.com/repos/$Repo/releases/$($rel.id)/assets"

foreach ($item in @(
    @{ path = $zipPath; name = $zipName; type = 'application/zip' },
    @{ path = $sumPath; name = 'SHA256SUMS.txt'; type = 'text/plain' }
  )) {
  if (-not (Test-Path $item.path)) { Write-Output ("skip (missing): " + $item.path); continue }
  # replace an asset with the same name
  $assets = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/$($rel.id)/assets" -Headers $h -Proxy $Proxy -TimeoutSec 40
  foreach ($a in $assets) {
    if ($a.name -eq $item.name) {
      Invoke-RestMethod -Uri $a.url -Method Delete -Headers $h -Proxy $Proxy -TimeoutSec 40 | Out-Null
      Write-Output ("replaced old asset " + $a.name)
    }
  }
  $mb = [math]::Round((Get-Item $item.path).Length / 1MB, 1)
  Write-Output ("uploading {0} ({1} MB) ..." -f $item.name, $mb)
  $uh = @{ Authorization = "Bearer $token"; 'Content-Type' = $item.type; Accept = 'application/vnd.github+json'; 'User-Agent' = 'dareu-release' }
  $r = Invoke-RestMethod -Uri "$upBase`?name=$($item.name)" -Method Post -Headers $uh -InFile $item.path -Proxy $Proxy -TimeoutSec 2400
  Write-Output ("  ok: " + $r.browser_download_url)
}

$rel2 = Invoke-RestMethod -Uri "$api/repos/$Repo/releases/tags/$Tag" -Headers $h -Proxy $Proxy -TimeoutSec 40
Write-Output ("assets=" + @($rel2.assets).Count + "  " + $rel2.html_url)
