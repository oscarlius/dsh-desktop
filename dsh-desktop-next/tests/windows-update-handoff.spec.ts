import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
// This is a process-level harness; never inherit the mocked child_process used
// by updater unit tests when Vitest reuses a worker.
vi.unmock('node:child_process')
const { canAutomaticWindowsApply, launchWindowsUpdateHandoff } = await import('../src/windows-update-handoff.ts')
const execute = promisify(execFile)
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const encoded = (script: string): string => Buffer.from(script, 'utf16le').toString('base64')

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function waitForStatus(root: string, phase: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000
  let last = ''
  while (Date.now() < deadline) {
    try {
      last = (await readFile(join(root, 'status.json'), 'utf8')).replace(/^\uFEFF/u, '')
      const status = JSON.parse(last) as Record<string, unknown>
      if (status.phase === phase) return status
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`did not observe handoff status ${phase}${last ? `; last=${last}` : ''}`)
}

it.skipIf(process.platform !== 'win32')('accepts exactly one disposable current-user Electron Builder uninstall record when not elevated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-preflight-')); roots.push(root)
  const product = `DSH Handoff Test ${randomUUID()}`
  const executable = join(root, 'Desktop.exe'); const uninstaller = join(root, `Uninstall ${product}.exe`)
  const key = `DSH-Handoff-${randomUUID()}`
  await writeFile(executable, 'fixture'); await writeFile(uninstaller, 'fixture')
  const baseEnv = { ...process.env, DSH_TEST_KEY: key, DSH_TEST_PRODUCT: product, DSH_TEST_ROOT: root, DSH_TEST_UNINSTALLER: uninstaller }
  const elevated = '$p=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent(); if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 0}; exit 1'
  const isElevated = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(elevated)], { windowsHide: true }).then(() => true, () => false)
  if (isElevated) { await expect(canAutomaticWindowsApply(executable, product)).resolves.toBe(false); return }
  const create = '$p="HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+$env:DSH_TEST_KEY; New-Item -Path $p -Force | Out-Null; New-ItemProperty -Path $p -Name DisplayName -Value $env:DSH_TEST_PRODUCT -PropertyType String -Force | Out-Null; New-ItemProperty -Path $p -Name UninstallString -Value ("`""+$env:DSH_TEST_UNINSTALLER+"`" /currentuser") -PropertyType String -Force | Out-Null'
  const cleanup = '$p="HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+$env:DSH_TEST_KEY; Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue'
  try {
    await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(create)], { windowsHide: true, env: baseEnv })
    await expect(canAutomaticWindowsApply(executable, product)).resolves.toBe(true)
  } finally { await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(cleanup)], { windowsHide: true, env: baseEnv }) }
})

it.skipIf(process.platform !== 'win32')('runs the fixed PowerShell sidecar through BOM-safe readiness and a harmless installer process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-harness-')); roots.push(root)
  const installer = join(root, 'harmless-installer.cmd')
  await writeFile(installer, '@echo off\r\nexit /b 0\r\n')
  await launchWindowsUpdateHandoff({ executable: process.execPath, installer, parentPid: 2147483647, statusDirectory: root })
  expect(await waitForStatus(root, 'installed')).toMatchObject({ phase: 'installed' })
})

it.skipIf(process.platform !== 'win32')('waits for the exact parent exit before starting the harmless installer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-parent-')); roots.push(root)
  const installer = join(root, 'installer.cmd'); const oldExe = join(root, 'old.cmd'); const marker = join(root, 'ran.txt')
  await writeFile(installer, `@echo off\r\necho installed > "${marker}"\r\nexit /b 0\r\n`)
  await writeFile(oldExe, '@echo off\r\nexit /b 0\r\n')
  const parent = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 8'], { windowsHide: true })
  try {
    await launchWindowsUpdateHandoff({ executable: oldExe, installer, parentPid: parent.pid!, statusDirectory: root })
    await new Promise(resolve => setTimeout(resolve, 300))
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
    parent.kill()
    expect(await waitForStatus(root, 'installed')).toMatchObject({ phase: 'installed' })
    expect(await readFile(marker, 'utf8')).toContain('installed')
  } finally { if (!parent.killed) parent.kill() }
})

it.skipIf(process.platform !== 'win32')('keeps the real helper alive after an ordinary unreferenced Node parent exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-node-parent-')); roots.push(root)
  const installer = join(root, 'installer.cmd'); const oldExe = join(root, 'old.cmd'); const marker = join(root, 'ran.txt'); const parentScript = join(root, 'parent.mjs')
  await writeFile(installer, `@echo off\r\necho installed > "${marker}"\r\nexit /b 0\r\n`)
  await writeFile(oldExe, '@echo off\r\nexit /b 0\r\n')
  const helperUrl = new URL('../src/windows-update-handoff.ts', import.meta.url).href
  await writeFile(parentScript, `import { launchWindowsUpdateHandoff } from ${JSON.stringify(helperUrl)}; await launchWindowsUpdateHandoff(${JSON.stringify({ executable: oldExe, installer, statusDirectory: root })});\n`)
  const parent = spawn(process.execPath, [parentScript], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let parentError = ''
  parent.stderr.on('data', chunk => { parentError = `${parentError}${String(chunk)}` })
  const parentCode = await new Promise<number | null>((resolveExit, reject) => { parent.once('error', reject); parent.once('exit', code => resolveExit(code)) })
  expect(parentCode, parentError).toBe(0)
  expect(await waitForStatus(root, 'installed')).toMatchObject({ phase: 'installed' })
  expect(await readFile(marker, 'utf8')).toContain('installed')
})

it.skipIf(process.platform !== 'win32')('does not install on a later parent exit after a handoff was cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-cancel-')); roots.push(root)
  const installer = join(root, 'installer.cmd'); const oldExe = join(root, 'old.cmd'); const marker = join(root, 'ran.txt')
  await writeFile(installer, `@echo off\r\necho installed > "${marker}"\r\nexit /b 0\r\n`)
  await writeFile(oldExe, '@echo off\r\nexit /b 0\r\n')
  const parent = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 8'], { windowsHide: true })
  try {
    await launchWindowsUpdateHandoff({ executable: oldExe, installer, parentPid: parent.pid!, statusDirectory: root })
    await writeFile(join(root, 'cancelled'), 'cancelled'); parent.kill()
    expect(await waitForStatus(root, 'cancelled')).toMatchObject({ phase: 'cancelled' })
    await expect(readFile(marker, 'utf8')).rejects.toThrow()
  } finally { if (!parent.killed) parent.kill() }
})

it.skipIf(process.platform !== 'win32')('records a failed installer and reopens the verified old executable only after that installer exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-handoff-failure-')); roots.push(root)
  const installer = join(root, 'installer.cmd'); const oldExe = join(root, 'old.cmd'); const marker = join(root, 'reopened.txt')
  await writeFile(installer, '@echo off\r\nexit /b 7\r\n')
  await writeFile(oldExe, `@echo off\r\necho reopened > "${marker}"\r\nexit /b 0\r\n`)
  await launchWindowsUpdateHandoff({ executable: oldExe, installer, parentPid: 2147483647, statusDirectory: root })
  expect(await waitForStatus(root, 'failed')).toMatchObject({ phase: 'failed' })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try { expect(await readFile(marker, 'utf8')).toContain('reopened'); return } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
  }
  throw new Error('verified old executable was not reopened after installer failure')
})
