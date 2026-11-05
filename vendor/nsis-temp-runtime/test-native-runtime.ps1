[CmdletBinding()]
param(
  [string] $BundleRoot = 'C:\Users\liushangfeng\AppData\Local\electron-builder\Cache\nsis@1.2.1\nsis-bundle-3.12-wfwns',
  [string] $TestRoot = 'E:\DSHBuilds',
  [switch] $AllowExistingFallback
)

$ErrorActionPreference = 'Stop'
$vendorRoot = Split-Path -Parent $PSCommandPath
$testRoot = [IO.Path]::GetFullPath($TestRoot)
if (!(Test-Path $testRoot)) { throw "Neutral test root missing: $testRoot" }
$workRoot = Join-Path $testRoot ('nsis-temp-runtime-test-' + [guid]::NewGuid())
$runtimeRoot = Join-Path $workRoot 'runtime'
$normalTemp = Join-Path $workRoot 'normal-temp'
$badTemp = Join-Path $workRoot 'not-a-directory'
$fallbackTemp = Join-Path $env:LOCALAPPDATA 'DSH-NEXT-InstallerTemp'

if (!(Test-Path (Join-Path $BundleRoot 'windows\makensis.exe'))) { throw "NSIS 3.12 bundle missing: $BundleRoot" }
if ((Test-Path $fallbackTemp) -and !$AllowExistingFallback) { throw "Fresh fallback test requires this path not to exist: $fallbackTemp" }
New-Item -ItemType Directory -Path $workRoot, $normalTemp | Out-Null
Copy-Item $BundleRoot $runtimeRoot -Recurse
Copy-Item (Join-Path $vendorRoot 'windows\Stubs\*') (Join-Path $runtimeRoot 'windows\Stubs') -Force
Copy-Item (Join-Path $vendorRoot 'probe.nsi') (Join-Path $workRoot 'probe.nsi')
Push-Location $workRoot
try {
  & (Join-Path $runtimeRoot 'makensis.cmd') /V2 (Join-Path $workRoot 'probe.nsi')
  if ($LASTEXITCODE) { throw 'Probe compilation failed' }

  function Invoke-Probe([string] $executable, [string] $tempPath, [string] $markerName, [string] $markerDirectory = $workRoot) {
    $oldTemp = $env:TEMP; $oldTmp = $env:TMP
    $marker = Join-Path $markerDirectory $markerName
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    try {
      $env:TEMP = $tempPath; $env:TMP = $tempPath
      $process = Start-Process -FilePath $executable -ArgumentList '/S' -PassThru -WindowStyle Hidden
      if (!$process.WaitForExit(10000)) { throw "Probe did not exit within 10 seconds with TEMP=$tempPath" }
      if ($process.ExitCode) { throw "Probe exited $($process.ExitCode) with TEMP=$tempPath" }
    } finally {
      $env:TEMP = $oldTemp; $env:TMP = $oldTmp
    }
    for ($attempt = 0; $attempt -lt 50 -and !(Test-Path $marker); $attempt++) { Start-Sleep -Milliseconds 100 }
    if (!(Test-Path $marker)) { throw "Marker missing: $marker" }
    $content = Get-Content $marker -Raw
    $parts = $content.TrimEnd("`r", "`n").Split('|')
    if ($parts.Count -ne 2 -or $parts[0].TrimEnd('\') -ne $parts[1].TrimEnd('\')) { throw "TEMP/TMP were not both set to the validated directory: $content" }
    return $parts[0].TrimEnd('\')
  }

  $normalReported = Invoke-Probe (Join-Path $workRoot 'nsis-temp-runtime-probe.exe') $normalTemp 'nsis-temp-runtime-install-marker.txt'
  if ($normalReported -ne $normalTemp) { throw "Normal TEMP was not preserved: $normalReported" }
  Set-Content -LiteralPath $badTemp -Value 'not a directory' -NoNewline
  $fallbackReported = Invoke-Probe (Join-Path $workRoot 'nsis-temp-runtime-probe.exe') $badTemp 'nsis-temp-runtime-install-marker.txt'
  if ($fallbackReported -notlike '*DSH-NEXT-InstallerTemp') { throw "Unexpected fallback path: $fallbackReported" }
  $uninstallReported = Invoke-Probe (Join-Path $workRoot 'nsis-temp-runtime-uninstall.exe') $badTemp 'nsis-temp-runtime-uninstall-marker.txt' $fallbackTemp
  if ($uninstallReported -notlike '*DSH-NEXT-InstallerTemp') { throw "Unexpected uninstaller fallback path: $uninstallReported" }
  [pscustomobject]@{ normalTemp = $normalReported; badTempFallback = $fallbackReported; badTempUninstallerFallback = $uninstallReported; result = 'passed' }
} finally {
  Pop-Location
  $expectedPrefix = Join-Path $testRoot 'nsis-temp-runtime-test-'
  if (!$workRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing cleanup outside test root: $workRoot" }
  Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
