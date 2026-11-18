<#
.SYNOPSIS
  Executes the install/restart/preservation portion of a real P7 company differential-update smoke.

.DESCRIPTION
  Download telemetry and the downloaded installer must come from the running packaged client
  (or its real updater harness).  This script deliberately does not manufacture either one.
  It only installs the supplied base package into an isolated root, starts the real application,
  verifies the supplied download evidence, runs the downloaded NSIS installer, and checks the
  restarted installed executable and caller-selected persisted files.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BaseInstaller,
  [Parameter(Mandatory = $true)][string]$CandidateInstaller,
  [Parameter(Mandatory = $true)][string]$DownloadedInstaller,
  [Parameter(Mandatory = $true)][string]$DownloadTelemetryPath,
  [Parameter(Mandatory = $true)][ValidateSet('differential', 'fallback')][string]$DownloadMode,
  [Parameter(Mandatory = $true)][string]$TaskRoot,
  [Parameter(Mandatory = $true)][guid]$ExpectedTestGuid,
  [Parameter(Mandatory = $true)][string[]]$PreserveRelativePath,
  [int]$TimeoutSeconds = 240,
  [switch]$AllowManualRelaunch,
  [bool]$KeepArtifacts = $true
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'This smoke test requires Windows.' }
if ($TimeoutSeconds -lt 10 -or $TimeoutSeconds -gt 600) { throw 'TimeoutSeconds must be between 10 and 600.' }

function Resolve-TaskFile([string]$value, [string]$label) {
  $item = Get-Item -LiteralPath $value -ErrorAction Stop
  if (-not $item.PSIsContainer) { return $item.FullName }
  throw "$label must be a file: $value"
}

function Assert-ChildPath([string]$root, [string]$path, [string]$label) {
  $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  $pathFull = [IO.Path]::GetFullPath($path)
  if (-not $pathFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$label must stay inside TaskRoot: $pathFull"
  }
  return $pathFull
}

function Get-CompanyUninstallEntries {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  return @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -like 'P7 DSH Company Test*'
  } | Select-Object PSPath, DisplayName, DisplayVersion, InstallLocation, UninstallString, QuietUninstallString)
}

function Get-TestUninstallEntry([guid]$guid) {
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"
  if (-not (Test-Path -LiteralPath $key)) { return $null }
  return Get-ItemProperty -LiteralPath $key
}

function Assert-TestUninstallEntry([guid]$guid, [string]$expectedUninstaller) {
  $entry = Get-TestUninstallEntry $guid
  if ($null -eq $entry -or $entry.DisplayName -notlike 'P7 DSH Company Test*') {
    throw "Expected test NSIS uninstall entry was not registered: $guid"
  }
  $expected = [IO.Path]::GetFullPath($expectedUninstaller)
  $command = [string]$entry.UninstallString
  if ($command.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Test NSIS uninstall entry does not target the isolated install root: $guid"
  }
  return $entry
}

function Get-ExactAppProcesses([string]$appPath) {
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.Equals($appPath, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Wait-TaskCondition([scriptblock]$condition, [string]$description) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $condition) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for $description."
}

function Start-TaskInstaller([string]$installer, [string]$installRoot, [bool]$updated = $false) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $arguments = @('/S', '/currentuser', "/D=$installRoot")
  if ($updated) { $arguments = @('--updated', '--force-run', '/S', '/currentuser', "/D=$installRoot") }
  $process = Start-Process -FilePath $installer -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden
  $watch.Stop()
  return [ordered]@{ exitCode = $process.ExitCode; elapsedMs = $watch.ElapsedMilliseconds }
}

function Read-RunMarker([string]$path) {
  $marker = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($marker.pid -isnot [int] -and $marker.pid -isnot [long]) { throw "Active-run marker has no numeric pid: $path" }
  return $marker
}

function Add-UpgradeFixtures([string]$fixtureDshHome, [string[]]$requested) {
  $all = [Collections.Generic.List[string]]::new()
  foreach ($path in $requested) { $all.Add($path) }
  # These are synthetic smoke fixtures, never represented as user configuration
  # or an actual user session. They prove that the selected DSH_HOME survives.
  foreach ($fixture in @('config/upgrade-sentinel.json', 'sessions/upgrade-sentinel.json')) {
    $target = Assert-ChildPath $fixtureDshHome (Join-Path $fixtureDshHome $fixture) 'Fixture path'
    if (-not (Test-Path -LiteralPath $target)) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      $value = [ordered]@{ fixture = 'company-differential-upgrade-smoke'; relativePath = $fixture; createdAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText($target, "$value`n", [Text.UTF8Encoding]::new($false))
    }
    $all.Add($fixture)
  }
  # A real profile may generate settings.yaml during base startup. If it does,
  # observe it; do not create a file that could be mistaken for user settings.
  if (Test-Path -LiteralPath (Join-Path $fixtureDshHome 'settings.yaml') -PathType Leaf) { $all.Add('settings.yaml') }
  return @($all | Select-Object -Unique)
}

function Start-TaskApplication([string]$appPath, [string]$installRoot, [hashtable]$environment) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $appPath
  $info.Arguments = "--user-data-dir=`"$($environment.userData)`""
  $info.WorkingDirectory = $installRoot
  $info.UseShellExecute = $false
  $info.EnvironmentVariables['APPDATA'] = $environment.appData
  $info.EnvironmentVariables['LOCALAPPDATA'] = $environment.localAppData
  $info.EnvironmentVariables['USERPROFILE'] = $environment.userProfile
  $info.EnvironmentVariables['HOME'] = $environment.home
  $info.EnvironmentVariables['DSH_HOME'] = $environment.dshHome
  $info.EnvironmentVariables['ELECTRON_ENABLE_LOGGING'] = '1'
  return [Diagnostics.Process]::Start($info)
}

function Get-FileDigest([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Get-PackagedManifestVersion([string]$appPath) {
  $manifest = Join-Path (Split-Path -Parent $appPath) 'resources\app\package.json'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "Packaged manifest is missing: $manifest" }
  $version = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
  if ($version -isnot [string] -or $version.Length -eq 0) { throw "Packaged manifest has no version: $manifest" }
  return $version
}

function Test-PeVersionMatchesSemVer([string]$peVersion, [string]$semVer) {
  if ($semVer -notmatch '^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$') { throw "Invalid expected semantic version: $semVer" }
  $expected = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
  return [version]$peVersion -eq [version]$expected
}

function Read-DownloadTelemetry([string]$path, [string]$mode, [long]$fullSize) {
  # Stable harness contract: one JSON object containing trace entries from the real HTTPS updater.
  $data = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if ($null -eq $data.entries) { throw 'Download telemetry must contain entries.' }
  $entries = @($data.entries)
  $rangeEntries = @($entries | Where-Object {
    $_.requestHeaders -and $_.requestHeaders.range -and [string]$_.requestHeaders.range -match '^bytes='
  })
  $bytes = [long]0
  foreach ($entry in $entries) {
    if ($null -ne $entry.responseBytes) { $bytes += [long]$entry.responseBytes }
  }
  $summary = [ordered]@{
    source = (Resolve-Path -LiteralPath $path).Path
    entries = $entries.Count
    rangeRequestCount = $rangeEntries.Count
    transferredBytes = $bytes
    fullInstallerBytes = $fullSize
    fallbackForced = [bool]$data.fallbackForced
  }
  if ($mode -eq 'differential') {
    if ($summary.rangeRequestCount -lt 1) { throw 'Differential evidence has no HTTP Range request.' }
    if ($summary.transferredBytes -ge $fullSize) { throw 'Differential evidence transferred the full installer or more.' }
  } else {
    if (-not $summary.fallbackForced) { throw 'Fallback evidence must state fallbackForced=true.' }
    if ($summary.transferredBytes -lt $fullSize) { throw 'Fallback evidence did not transfer a full installer.' }
  }
  return $summary
}

$base = Resolve-TaskFile $BaseInstaller 'BaseInstaller'
$candidate = Resolve-TaskFile $CandidateInstaller 'CandidateInstaller'
$downloaded = Resolve-TaskFile $DownloadedInstaller 'DownloadedInstaller'
$telemetry = Resolve-TaskFile $DownloadTelemetryPath 'DownloadTelemetryPath'
$root = [IO.Path]::GetFullPath($TaskRoot)
if (-not ([IO.Path]::GetFileName($root).StartsWith('upgrade-smoke', [StringComparison]::OrdinalIgnoreCase))) {
  throw "TaskRoot must be a task-owned upgrade-smoke directory: $root"
}
if (Test-Path -LiteralPath $root) { throw "TaskRoot must not already exist: $root" }

$installRoot = Join-Path $root 'install'
$appData = Join-Path $root 'appdata'
$localAppData = Join-Path $root 'localappdata'
$userData = Join-Path $root 'user-data'
$dshHome = Join-Path $root 'dsh-home'
$userProfile = Join-Path $root 'userprofile'
$appPath = Join-Path $installRoot 'P7 DSH Company Test.exe'
$markerPath = Join-Path $userData 'crash-evidence\active-run.json'
$uninstallerPath = Join-Path $installRoot 'Uninstall P7 DSH Company Test.exe'
$environment = @{ appData = $appData; localAppData = $localAppData; userData = $userData; dshHome = $dshHome; userProfile = $userProfile; home = $userProfile }
$result = [ordered]@{
  scenario = 'real company NSIS upgrade lifecycle with isolated Electron and DSH state'
  taskRoot = $root
  base = [ordered]@{ path = $base; sha256 = Get-FileDigest $base; version = (Get-Item -LiteralPath $base).VersionInfo.ProductVersion }
  candidate = [ordered]@{ path = $candidate; sha256 = Get-FileDigest $candidate; version = (Get-Item -LiteralPath $candidate).VersionInfo.ProductVersion }
  downloadedInstaller = [ordered]@{ path = $downloaded; sha256 = Get-FileDigest $downloaded; version = (Get-Item -LiteralPath $downloaded).VersionInfo.ProductVersion }
  isolation = $environment
  telemetry = $null
  baseInstall = $null
  candidateInstall = $null
  baseProcess = $null
  candidateProcess = $null
  preserved = @()
  fixtures = @()
  cleanup = [ordered]@{ uninstallerExitCode = $null; processesRemaining = $null; taskRootRemoved = $false }
  registeredTestUninstall = $null
  error = $null
  success = $false
}

try {
  # A production company install may coexist only when the supplied two-package
  # test build uses its own NSIS guid. We never mutate its registry entry.
  if ($null -ne (Get-TestUninstallEntry $ExpectedTestGuid)) { throw "Refusing to overwrite the test NSIS uninstall key: $ExpectedTestGuid" }
  $companyProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'P7 DSH Company Test.exe' })
  if ($companyProcesses.Count -gt 0) { throw 'Refusing to run while a P7 DSH Company Test process exists.' }
  if ($result.base.version -eq $result.candidate.version) { throw 'Base and candidate package versions must differ.' }
  if ($result.candidate.sha256 -ne $result.downloadedInstaller.sha256) { throw 'Downloaded installer digest does not match CandidateInstaller.' }
  $result.telemetry = Read-DownloadTelemetry $telemetry $DownloadMode (Get-Item -LiteralPath $candidate).Length
  New-Item -ItemType Directory -Path $root, $appData, $localAppData, $userData, $dshHome, $userProfile -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $userProfile 'AppData/Roaming'), (Join-Path $userProfile 'AppData/Local'), (Join-Path $userData 'data-directory') -Force | Out-Null
  # Test-only locator: the NSIS relaunch may not inherit the launcher's DSH_HOME.
  $locator = [ordered]@{ version = 1; activeHome = $dshHome; previousHome = $null; generation = 1; updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
  $locator | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $userData 'data-directory/state.json') -Encoding utf8

  $result.baseInstall = Start-TaskInstaller $base $installRoot
  if ($result.baseInstall.exitCode -ne 0 -or -not (Test-Path -LiteralPath $appPath)) { throw 'Base installer did not produce the expected company executable.' }
  $basePeVersion = (Get-Item -LiteralPath $appPath).VersionInfo.ProductVersion
  $baseManifestVersion = Get-PackagedManifestVersion $appPath
  $result.base.installedPeVersion = $basePeVersion
  $result.base.installedManifestVersion = $baseManifestVersion
  if ($baseManifestVersion -ne $result.base.version -or -not (Test-PeVersionMatchesSemVer $basePeVersion $baseManifestVersion)) { throw 'Installed base manifest or numeric PE version differs from BaseInstaller.' }
  $registered = Assert-TestUninstallEntry $ExpectedTestGuid $uninstallerPath
  if ($registered.DisplayVersion -ne $baseManifestVersion) { throw 'Test NSIS DisplayVersion differs from the base manifest version.' }
  $result.registeredTestUninstall = [ordered]@{ key = $registered.PSPath; displayName = $registered.DisplayName; installLocation = $registered.InstallLocation }
  $baseProcess = Start-TaskApplication $appPath $installRoot $environment
  $result.baseProcess = [ordered]@{ pid = $baseProcess.Id; executablePath = $appPath; markerObserved = $false }
  Wait-TaskCondition { (Get-ExactAppProcesses $appPath).Count -gt 0 } 'base application process at the isolated install path'
  Wait-TaskCondition { Test-Path -LiteralPath $markerPath } 'base active-run marker in isolated user data'
  $baseMarker = Read-RunMarker $markerPath
  if ($baseMarker.pid -ne $baseProcess.Id) { throw "Base active-run marker pid does not match the isolated base process: $($baseMarker.pid)" }
  $baseMarkerWriteUtc = (Get-Item -LiteralPath $markerPath).LastWriteTimeUtc
  $result.baseProcess.markerObserved = $true

  $preserved = @()
  $fixturePaths = Add-UpgradeFixtures $dshHome $PreserveRelativePath
  $result.fixtures = @($fixturePaths | Where-Object { $_ -in @('config/upgrade-sentinel.json', 'sessions/upgrade-sentinel.json') })
  foreach ($relative in $fixturePaths) {
    if ([IO.Path]::IsPathRooted($relative)) { throw "PreserveRelativePath must be relative: $relative" }
    $path = Assert-ChildPath $dshHome (Join-Path $dshHome $relative) 'Preserved path'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required preserved file does not exist before upgrade: $relative" }
    $preserved += [ordered]@{ relativePath = $relative; beforeSha256 = Get-FileDigest $path; afterSha256 = $null; preserved = $false }
  }
  $result.preserved = $preserved

  $result.candidateInstall = Start-TaskInstaller $downloaded $installRoot $true
  if ($result.candidateInstall.exitCode -ne 0) { throw "Candidate installer exited $($result.candidateInstall.exitCode)." }
  Wait-TaskCondition { $baseProcess.Refresh(); $baseProcess.HasExited } 'base application shutdown by the candidate installer'
  $candidatePeVersion = (Get-Item -LiteralPath $appPath).VersionInfo.ProductVersion
  $candidateManifestVersion = Get-PackagedManifestVersion $appPath
  $result.candidate.installedPeVersion = $candidatePeVersion
  $result.candidate.installedManifestVersion = $candidateManifestVersion
  if ($candidateManifestVersion -ne $result.candidate.version -or -not (Test-PeVersionMatchesSemVer $candidatePeVersion $candidateManifestVersion)) { throw 'Installed candidate manifest or numeric PE version differs from CandidateInstaller.' }
  $registeredCandidate = Assert-TestUninstallEntry $ExpectedTestGuid $uninstallerPath
  if ($registeredCandidate.DisplayVersion -ne $candidateManifestVersion) { throw 'Test NSIS DisplayVersion differs from the candidate manifest version.' }
  $result.registeredTestUninstall = [ordered]@{ key = $registeredCandidate.PSPath; displayName = $registeredCandidate.DisplayName; installLocation = $registeredCandidate.InstallLocation }
  $candidateProcesses = @(Get-ExactAppProcesses $appPath | Where-Object { $_.ProcessId -ne $baseProcess.Id })
  $manualRelaunch = $false
  if ($candidateProcesses.Count -eq 0 -and $AllowManualRelaunch) {
    $candidateProcess = Start-TaskApplication $appPath $installRoot $environment
    $candidateProcesses = @($candidateProcess)
    $manualRelaunch = $true
  }
  if ($candidateProcesses.Count -eq 0) {
    throw 'Candidate installer did not automatically relaunch the isolated application. Re-run only with -AllowManualRelaunch for a separately labelled manual-restart diagnosis.'
  }
  $result.candidateProcess = [ordered]@{ pid = $candidateProcesses[0].ProcessId; executablePath = $appPath; markerObserved = $false; automaticRelaunch = -not $manualRelaunch }
  Wait-TaskCondition { (Get-ExactAppProcesses $appPath | Where-Object { $_.ProcessId -ne $baseProcess.Id }).Count -gt 0 } 'candidate application process at the isolated install path'
  Wait-TaskCondition {
    if (-not (Test-Path -LiteralPath $markerPath)) { return $false }
    $markerInfo = Get-Item -LiteralPath $markerPath
    if ($markerInfo.LastWriteTimeUtc -le $baseMarkerWriteUtc) { return $false }
    $marker = Read-RunMarker $markerPath
    return (@(Get-ExactAppProcesses $appPath | ForEach-Object ProcessId) -contains $marker.pid)
  } 'fresh candidate active-run marker with an isolated candidate pid'
  $candidateMarker = Read-RunMarker $markerPath
  if ($candidateMarker.version -ne $candidateManifestVersion) { throw 'Candidate active-run marker version differs from the packaged manifest.' }
  $result.candidateProcess.markerObserved = $true
  $result.candidateProcess.markerPid = $candidateMarker.pid
  foreach ($entry in $preserved) {
    $path = Assert-ChildPath $dshHome (Join-Path $dshHome $entry.relativePath) 'Preserved path'
    $entry.afterSha256 = Get-FileDigest $path
    $entry.preserved = $entry.beforeSha256 -eq $entry.afterSha256
    if (-not $entry.preserved) { throw "Preserved file changed across upgrade: $($entry.relativePath)" }
  }
} catch {
  $result.error = $_.Exception.Message
} finally {
  foreach ($process in (Get-ExactAppProcesses $appPath)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $uninstallerPath) {
    $uninstaller = Start-Process -FilePath $uninstallerPath -ArgumentList '/S', '/currentuser' -PassThru -WindowStyle Hidden
    if ($uninstaller.WaitForExit($TimeoutSeconds * 1000)) { $result.cleanup.uninstallerExitCode = $uninstaller.ExitCode }
    else { $result.error = $result.error ?? 'The isolated uninstaller did not finish within the test timeout.' }
  }
  $remainingTestEntry = Get-TestUninstallEntry $ExpectedTestGuid
  if ($null -ne $remainingTestEntry) { $result.error = $result.error ?? "Test NSIS uninstall key remains after cleanup: $ExpectedTestGuid" }
  $result.cleanup.processesRemaining = (Get-ExactAppProcesses $appPath).Count
  if (-not $KeepArtifacts -and $result.cleanup.uninstallerExitCode -eq 0 -and (Test-Path -LiteralPath $root)) {
    Remove-Item -LiteralPath $root -Recurse -Force
  }
  $result.cleanup.taskRootRemoved = -not (Test-Path -LiteralPath $root)
}

$result.success = ($null -eq $result.error -and $result.baseInstall.exitCode -eq 0 -and $result.candidateInstall.exitCode -eq 0 -and $result.baseProcess.markerObserved -and $result.candidateProcess.markerObserved -and $result.candidateProcess.automaticRelaunch -and ($result.preserved | Where-Object { -not $_.preserved }).Count -eq 0 -and $result.cleanup.uninstallerExitCode -eq 0 -and $result.cleanup.processesRemaining -eq 0 -and ($KeepArtifacts -or $result.cleanup.taskRootRemoved))
$result | ConvertTo-Json -Depth 8
if (-not $result.success) { exit 1 }
