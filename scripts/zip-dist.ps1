# Zip the packaged app into release/ for a GitHub Release asset.
# ASCII only: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/zip-dist.ps1 [-Version 1.0.0]
param(
  [string]$Version = '',
  [string]$Arch = 'win32-x64'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -eq '') {
  # read "version" without ConvertFrom-Json (5.1 mangles UTF-8 read of package.json)
  $raw = [IO.File]::ReadAllText((Join-Path $root 'package.json'))
  if ($raw -match '"version"\s*:\s*"([^"]+)"') { $Version = $Matches[1] } else { throw 'cannot read version' }
}

$appName = "DAREU-Driver-$Arch"
$srcDir = Join-Path $root "dist\$appName"
if (-not (Test-Path (Join-Path $srcDir 'DAREU-Driver.exe'))) { throw "not packed yet: $srcDir (run: npm run pack)" }

# drop runtime state produced by smoke tests, keep the zip clean
foreach ($junk in @('dareu-state', 'logs')) {
  $p = Join-Path $srcDir $junk
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}

$outDir = Join-Path $root 'release'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$zip = Join-Path $outDir "$appName-v$Version.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($srcDir, $zip, 'Optimal', $false)

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
$fileCount = @(Get-ChildItem $srcDir -Recurse -File).Count
Write-Output ("ZIP {0}  {1} MB  ({2} files)" -f $zip, $mb, $fileCount)
# sha256 for the release notes
$hash = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
Write-Output ("SHA256 $hash")
Set-Content -Path "$zip.sha256" -Value "$hash  $(Split-Path -Leaf $zip)" -Encoding ASCII
Write-Output "WROTE $zip.sha256"
