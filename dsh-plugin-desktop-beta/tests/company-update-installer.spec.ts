import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyCompanyInstaller } from '../src/company-update-installer.ts'
import type { PublishedCompanyRelease } from '../src/company-update-check.ts'

let root: string
const release: PublishedCompanyRelease = { status: 'update-available', version: '2.0.18-beta.4', releaseNotes: '',
  downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/setup.exe', sha256: createHash('sha256').update('installer').digest('hex') }
async function installer() {
  root = await mkdtemp(join(tmpdir(), 'p7-installer-'))
  const path = join(root, 'setup.exe'); await writeFile(path, 'installer')
  await writeFile(join(root, 'settings.yaml'), 'preserved: true')
  return path
}
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('company installer identity', () => {
  it('requires matching company product and full SemVer and does not touch user settings', async () => {
    const path = await installer()
    await verifyCompanyInstaller(path, release, new AbortController().signal, async () => ({ ProductName: 'P7 DSH Company Test', ProductVersion: release.version }))
    expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toBe('preserved: true')
  })
  it.each([{ ProductName: 'DSH Desktop Beta', ProductVersion: release.version },
    { ProductName: 'P7 DSH Company Test', ProductVersion: '2.0.18-beta.3' }])('rejects a different product/version %j', async identity => {
    await expect(verifyCompanyInstaller(await installer(), release, new AbortController().signal, async () => identity)).rejects.toThrow('product or version')
  })
  it('detects local file tampering before reading or starting the installer', async () => {
    const path = await installer(); await writeFile(path, 'tampered')
    const reader = vi.fn()
    await expect(verifyCompanyInstaller(path, release, new AbortController().signal, reader)).rejects.toThrow('digest changed')
    expect(reader).not.toHaveBeenCalled()
  })
  it('does not continue verification after disposal', async () => {
    const reader = vi.fn()
    await expect(verifyCompanyInstaller(await installer(), release, AbortSignal.abort(), reader)).rejects.toThrow()
    expect(reader).not.toHaveBeenCalled()
  })
})
