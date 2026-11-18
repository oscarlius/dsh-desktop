/** Verify the company installer identity without starting any executable from the download. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PublishedCompanyRelease } from './company-update-check.ts'

const run = promisify(execFile)
const VERSION_SCRIPT = '$ErrorActionPreference="Stop"; (Get-Item -LiteralPath $env:P7_DSH_UPDATE_INSTALLER).VersionInfo | Select-Object ProductName,ProductVersion | ConvertTo-Json -Compress'

export async function readCompanyInstallerIdentity(path: string, signal: AbortSignal): Promise<unknown> {
  const { stdout } = await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VERSION_SCRIPT], {
      env: { ...process.env, P7_DSH_UPDATE_INSTALLER: path }, signal, timeout: 30_000, windowsHide: true, maxBuffer: 16_384,
    })
  return JSON.parse(stdout.replace(/^\uFEFF/u, '').trim()) as unknown
}

/** Recheck bytes immediately before install, including after a delayed user confirmation. */
export async function verifyCompanyInstaller(
  path: string,
  release: PublishedCompanyRelease,
  signal: AbortSignal,
  readIdentity: (path: string, signal: AbortSignal) => Promise<unknown> = readCompanyInstallerIdentity,
): Promise<void> {
  signal.throwIfAborted()
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  if (hash.digest('hex') !== release.sha256) throw new Error('P7 installer digest changed')
  const identity = await readIdentity(path, signal)
  if (identity === null || typeof identity !== 'object'
    || (identity as { ProductName?: unknown }).ProductName !== 'P7 DSH Company Test'
    || (identity as { ProductVersion?: unknown }).ProductVersion !== release.version) {
    throw new Error('P7 installer product or version does not match the published release')
  }
  signal.throwIfAborted()
}
