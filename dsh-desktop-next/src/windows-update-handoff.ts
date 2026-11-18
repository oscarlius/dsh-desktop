/** Fail-closed, current-user-only Windows installer handoff for silent company updates. */
import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { access, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const wscript = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/wscript.exe')
const encoded = (script: string): string => Buffer.from(script, 'utf16le').toString('base64')

export const WINDOWS_UPDATE_HANDOFF_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$installer = $env:DSH_UPDATE_INSTALLER; $oldExe = $env:DSH_UPDATE_OLD_EXE; $installRoot = $env:DSH_UPDATE_INSTALL_ROOT; $status = $env:DSH_UPDATE_STATUS; $cancelled = $env:DSH_UPDATE_CANCELLED; $parent = [int]$env:DSH_UPDATE_PARENT_PID',
  '$self = Get-Process -Id $PID -ErrorAction Stop; $helperPid = [int]$PID; $helperStartTicks = [string]$self.StartTime.Ticks; $installerPid = $null; $installerStartTicks = $null',
  'if (Test-Path -LiteralPath $cancelled) { exit 2 }',
  'function Write-Status([string]$phase, [string]$detail = "") { $value = @{ phase = $phase; detail = $detail.Substring(0, [Math]::Min(240, $detail.Length)); helperPid = $helperPid; helperStartTicks = $helperStartTicks }; if ($null -ne $installerPid) { $value.installerPid = $installerPid; $value.installerStartTicks = $installerStartTicks }; $json = $value | ConvertTo-Json -Compress; $tmp = "$status.tmp"; [IO.File]::WriteAllText($tmp, $json, [Text.UTF8Encoding]::new($false)); Move-Item -LiteralPath $tmp -Destination $status -Force }',
  'try { if (!(Test-Path -LiteralPath $installer -PathType Leaf) -or !(Test-Path -LiteralPath $oldExe -PathType Leaf) -or !(Test-Path -LiteralPath $installRoot -PathType Container)) { throw "handoff paths are unavailable" }; $parentProcess=Get-Process -Id $parent -ErrorAction SilentlyContinue; if ($parentProcess) { $null=$parentProcess.Handle }; Write-Status "ready" } catch { Write-Status "failed" $_.Exception.Message; exit 1 }',
  // Open the original process before acknowledging readiness. A process can
  // remain queryable after exit, and a PID can later belong to another process.
  'if ($parentProcess -and !$parentProcess.WaitForExit(90000)) { Write-Status "parent-timeout"; exit 2 }',
  'if (Test-Path -LiteralPath $cancelled) { Write-Status "cancelled"; exit 2 }',
  '$child = $null; try { $child = Start-Process -FilePath $installer -ArgumentList @("/S", "/currentuser", "--company-auto-update", "--updated", "--force-run", "/D=$installRoot") -WindowStyle Hidden -PassThru; $installerPid = [int]$child.Id; $installerStartTicks = [string]$child.StartTime.Ticks; Write-Status "installing"; $installerDeadline = [DateTime]::UtcNow.AddMinutes(10); while (!$child.HasExited -and [DateTime]::UtcNow -lt $installerDeadline) { Start-Sleep -Milliseconds 200; $child.Refresh() }; if (!$child.HasExited) { Write-Status "installer-timeout"; exit 4 }; if ($child.ExitCode -ne 0) { throw "installer exit $($child.ExitCode)" }; Write-Status "installed" } catch { Write-Status "failed" $_.Exception.Message; if ($null -eq $child -or $child.HasExited) { try { Start-Process -FilePath $oldExe -WindowStyle Hidden } catch {} }; exit 3 }',
].join('\n')

export type WindowsHandoffOptions = Readonly<{ executable: string; installer: string; parentPid?: number; statusDirectory?: string }>

type HandoffStatus = Readonly<{ phase: 'ready' | 'installing' | 'installer-timeout'; helperPid: number; helperStartTicks: string; installerPid?: number; installerStartTicks?: string }>
const validIdentity = (pid: unknown, ticks: unknown): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0 && typeof ticks === 'string' && /^[1-9][0-9]{12,}$/u.test(ticks)
function parseActiveStatus(directory: string): HandoffStatus | undefined {
  const status = join(directory, 'status.json')
  try {
    const info = lstatSync(status, { throwIfNoEntry: false })
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined
    const value = JSON.parse(readFileSync(status, 'utf8').replace(/^\uFEFF/u, '')) as Record<string, unknown>
    if (!['ready', 'installing', 'installer-timeout'].includes(String(value.phase)) || !validIdentity(value.helperPid, value.helperStartTicks)) return undefined
    if ((value.installerPid !== undefined || value.installerStartTicks !== undefined) && !validIdentity(value.installerPid, value.installerStartTicks)) return undefined
    return value as HandoffStatus
  } catch { return undefined }
}

/** Proves a bounded status record still names the exact live handoff process(es), defeating PID reuse. */
export async function isWindowsUpdateHandoffActive(directory: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const status = parseActiveStatus(directory)
  if (!status) return false
  const script = '$ErrorActionPreference="Stop"; function Live($targetPid,$ticks) { try { $p=Get-Process -Id $targetPid -ErrorAction Stop; return !$p.HasExited -and ([string]$p.StartTime.Ticks -eq $ticks) } catch { return $false } }; $helper=Live ([int]$env:DSH_UPDATE_HELPER_PID) $env:DSH_UPDATE_HELPER_TICKS; $installer=$false; if($env:DSH_UPDATE_INSTALLER_PID){ $installer=Live ([int]$env:DSH_UPDATE_INSTALLER_PID) $env:DSH_UPDATE_INSTALLER_TICKS }; if($helper -or $installer){ exit 0 }; exit 1'
  try {
    await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { timeout: 5_000, windowsHide: true, env: { ...process.env,
      DSH_UPDATE_HELPER_PID: String(status.helperPid), DSH_UPDATE_HELPER_TICKS: status.helperStartTicks,
      ...(status.installerPid === undefined ? {} : { DSH_UPDATE_INSTALLER_PID: String(status.installerPid), DSH_UPDATE_INSTALLER_TICKS: status.installerStartTicks! }),
    } })
    return true
  } catch { return false }
}

/** Proves an automatic handoff targets exactly a writable HKCU installer root. */
export async function canAutomaticWindowsApply(executable: string, productName: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const script = [
    '$ErrorActionPreference="Stop"; $principal=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent(); if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){ exit 1 }; $exe=[IO.Path]::GetFullPath($env:DSH_UPDATE_OLD_EXE); if(!(Test-Path -LiteralPath $exe -PathType Leaf)){ exit 1 }; $root=[IO.Path]::GetDirectoryName($exe)',
    '$keys=Get-ChildItem "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" -ErrorAction Stop | ForEach-Object { Get-ItemProperty $_.PSPath }',
    // Electron Builder stores InstallLocation under Software/<GUID>, while
    // the uninstall record carries the authoritative quoted uninstaller path.
    'function Matches-Root($entry) { if (!$entry.UninstallString) { return $false }; $pathMatch=[regex]::Match($entry.UninstallString,\'^(?:")([^"\\r\\n]+)"(?:\\s|$)\'); if (!$pathMatch.Success) { return $false }; $expected=Join-Path $root ("Uninstall "+$env:DSH_UPDATE_PRODUCT_NAME+".exe"); return [IO.Path]::GetFullPath($pathMatch.Groups[1].Value) -eq $expected }',
    // electron-builder appends the package SemVer to DisplayName. Permit only
    // that exact suffix, never a product-name prefix or arbitrary trailing text.
    'function Matches-DisplayName($entry) { $displayName=[string]$entry.DisplayName; $product=$env:DSH_UPDATE_PRODUCT_NAME; if ($displayName -ceq $product) { return $true }; return $displayName -cmatch (\'^\'+[regex]::Escape($product)+\' (?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-(?:(?:0|[1-9]\\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))(?:\\.(?:(?:0|[1-9]\\d*)|(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$\') }',
    '$match=@($keys | Where-Object { (Matches-DisplayName $_) -and (Matches-Root $_) -and $_.UninstallString -match \'(?:^|\\s)/currentuser(?:\\s|$)\' })',
    'if($match.Count -ne 1){ exit 2 }; $uninstaller=Join-Path $root ("Uninstall "+$env:DSH_UPDATE_PRODUCT_NAME+".exe"); if(!(Test-Path -LiteralPath $uninstaller -PathType Leaf)){ exit 2 }; $machine=Get-ChildItem "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall" -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath }; if(@($machine | Where-Object { Matches-Root $_ }).Count -ne 0){ exit 3 }',
    '$probe=Join-Path $root (".dsh-update-probe-"+[guid]::NewGuid().ToString("N")); try { [IO.File]::WriteAllText($probe,"ok"); Remove-Item -LiteralPath $probe -Force; exit 0 } catch { exit 4 }',
  ].join('; ')
  try { await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { timeout: 15_000, windowsHide: true, env: { ...process.env, DSH_UPDATE_OLD_EXE: executable, DSH_UPDATE_PRODUCT_NAME: productName } }); return true } catch { return false }
}

async function waitForReady(status: string, child: ReturnType<typeof spawn>, spawnFailure: () => Error | undefined, output: () => string): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if (existsSync(status)) {
      const value = JSON.parse((await readFile(status, 'utf8')).replace(/^\uFEFF/u, '')) as { phase?: unknown; detail?: unknown }
      if (value.phase === 'ready') return
      throw new Error(`Windows update handoff failed before shutdown: ${typeof value.detail === 'string' ? value.detail : 'unknown error'}`)
    }
    if (spawnFailure()) throw spawnFailure()!
    if (child.exitCode !== null && child.exitCode !== undefined && child.exitCode !== 0) throw new Error(`Windows update handoff exited before readiness (${String(child.exitCode)})${output() ? `: ${output()}` : ''}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Windows update handoff did not acknowledge readiness')
}

/** Starts only a fixed local sidecar and waits for its pre-exit readiness record. */
export async function launchWindowsUpdateHandoff(options: WindowsHandoffOptions): Promise<void> {
  const root = options.statusDirectory ?? await mkdtemp(join(tmpdir(), 'dsh-update-handoff-'))
  const status = join(root, 'status.json')
  const launcher = join(root, 'windows-update-launcher.vbs')
  const cancelled = join(root, 'cancelled')
  await access(options.installer); await access(options.executable)
  if (await lstat(cancelled).catch(() => undefined)) throw new Error('Windows update handoff was cancelled')
  const oldStatus = await lstat(status).catch(() => undefined)
  if (oldStatus && (!oldStatus.isFile() || oldStatus.isSymbolicLink())) throw new Error('Windows update handoff status path is unsafe')
  if (oldStatus) await rm(status, { force: true })
  // A detached GUI launcher avoids both Windows PowerShell's detached-console
  // initialization failure and Node's parent-owned child process job.
  const oldLauncher = await lstat(launcher).catch(() => undefined)
  if (oldLauncher && (!oldLauncher.isFile() || oldLauncher.isSymbolicLink())) throw new Error('Windows update launcher path is unsafe')
  if (oldLauncher) await rm(launcher, { force: true })
  await writeFile(launcher, 'Set shell = CreateObject("WScript.Shell")\r\nSet env = shell.Environment("PROCESS")\r\nshell.Run Chr(34) & env("DSH_UPDATE_POWERSHELL") & Chr(34) & " -NoProfile -NonInteractive -EncodedCommand " & env("DSH_UPDATE_ENCODED_SCRIPT"), 0, False\r\n', { flag: 'wx', mode: 0o600 })
  const child = spawn(wscript, ['//B', '//NoLogo', launcher], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    env: { ...process.env, DSH_UPDATE_POWERSHELL: powershell, DSH_UPDATE_ENCODED_SCRIPT: encoded(WINDOWS_UPDATE_HANDOFF_SCRIPT), DSH_UPDATE_INSTALLER: resolve(options.installer), DSH_UPDATE_OLD_EXE: resolve(options.executable), DSH_UPDATE_INSTALL_ROOT: win32.dirname(options.executable), DSH_UPDATE_PARENT_PID: String(options.parentPid ?? process.pid), DSH_UPDATE_STATUS: status, DSH_UPDATE_CANCELLED: cancelled },
  })
  let failure: Error | undefined
  let output = ''
  const appendOutput = (chunk: Buffer | string): void => { output = `${output}${String(chunk)}`.slice(-1024) }
  child.stdout?.on('data', appendOutput); child.stderr?.on('data', appendOutput)
  child.once('error', error => { failure = error })
  try { await waitForReady(status, child, () => failure, () => output.trim()); child.stdout?.destroy(); child.stderr?.destroy(); child.unref() }
  catch (error) { await writeFile(cancelled, 'cancelled', { flag: 'wx', mode: 0o600 }).catch(() => {}); child.kill(); throw error }
}
