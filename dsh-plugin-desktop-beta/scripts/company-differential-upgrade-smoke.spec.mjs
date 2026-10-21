import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./company-differential-upgrade-smoke.ps1', import.meta.url)), 'utf8')

for (const required of [
  "[ValidateSet('differential', 'fallback')]",
  "Arguments = \"--user-data-dir=",
  "EnvironmentVariables['APPDATA']",
  "EnvironmentVariables['LOCALAPPDATA']",
  "EnvironmentVariables['DSH_HOME']",
  "Get-ExactAppProcesses $appPath",
  'Downloaded installer digest does not match CandidateInstaller',
  'Differential evidence has no HTTP Range request',
  'Fallback evidence must state fallbackForced=true',
  'Preserved file changed across upgrade',
  'Candidate installer did not automatically relaunch',
  'AllowManualRelaunch',
  "'--updated', '--force-run', '/S', '/currentuser'",
  'config/upgrade-sentinel.json',
  'sessions/upgrade-sentinel.json',
  'Base active-run marker pid does not match',
  'fresh candidate active-run marker with an isolated candidate pid',
  'Assert-TestUninstallEntry',
  'Get-PackagedManifestVersion',
  'Test-PeVersionMatchesSemVer',
  'Installed candidate manifest or numeric PE version differs',
  'Candidate active-run marker version differs from the packaged manifest',
  "StartsWith('upgrade-smoke'",
  'ExpectedTestGuid',
  'Get-TestUninstallEntry',
]) assert.ok(source.includes(required), `missing safety or evidence guard: ${required}`)

assert.ok(!source.includes('DSH Desktop Beta.exe'), 'company smoke must not target the Beta executable')
assert.ok(!source.includes("Join-Path $env:APPDATA 'DSH Desktop'"), 'company smoke must not use the caller user-data directory')
console.log('company differential upgrade smoke static contract: passed')
