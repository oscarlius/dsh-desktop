param(
  [Parameter(Mandatory=$true)][string]$P7Repository,
  [Parameter(Mandatory=$true)][string]$Python,
  [Parameter(Mandatory=$true)][string]$Artifacts
)
$ErrorActionPreference = 'Stop'
$fixtureScript = Join-Path $P7Repository 'pro7/admin_api/tests/manual/dsh_loopback.py'
$nodeScript = Join-Path $PSScriptRoot 'p7-loopback.mjs'
New-Item -ItemType Directory -Force -Path $Artifacts | Out-Null
$readyPath = Join-Path $Artifacts 'p7-loopback-ready.json'
$reportPath = Join-Path $Artifacts 'p7-dsh-network-integration.json'
if (Test-Path -LiteralPath $readyPath) { Remove-Item -LiteralPath $readyPath }
$previousCA = $env:NODE_EXTRA_CA_CERTS
$previousNoProxy = $env:NO_PROXY
$fixtureProcess = $null
try {
  $fixtureProcess = Start-Process -FilePath $Python -ArgumentList @('"' + $fixtureScript + '"', '--output', '"' + $readyPath + '"') -WorkingDirectory (Join-Path $P7Repository 'pro7') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Artifacts 'p7-loopback-server.log') -RedirectStandardError (Join-Path $Artifacts 'p7-loopback-server.err.log')
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (!(Test-Path -LiteralPath $readyPath)) {
    if ($fixtureProcess.HasExited) { throw 'P7 fixture exited; inspect p7-loopback-server.err.log' }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'P7 fixture readiness timeout' }
    Start-Sleep -Milliseconds 200
  }
  $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
  $env:NODE_EXTRA_CA_CERTS = $ready.caPath
  $env:NO_PROXY = '127.0.0.1,localhost'
  & node $nodeScript $readyPath $reportPath
  if ($LASTEXITCODE -ne 0) { throw "DSH integration failed ($LASTEXITCODE); inspect $reportPath" }
} finally {
  if ($fixtureProcess -and !$fixtureProcess.HasExited) {
    if (Test-Path -LiteralPath $readyPath) {
      $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
      $env:NODE_EXTRA_CA_CERTS = $ready.caPath
      & node -e "fetch(process.argv[1]+'/__fixture/shutdown',{method:'POST',signal:AbortSignal.timeout(2000)}).catch(()=>{})" $ready.origin
    }
    if (!$fixtureProcess.WaitForExit(5000)) { Stop-Process -Id $fixtureProcess.Id -Force }
  }
  $env:NODE_EXTRA_CA_CERTS = $previousCA
  $env:NO_PROXY = $previousNoProxy
  if (Test-Path -LiteralPath $readyPath) { Remove-Item -LiteralPath $readyPath }
}
