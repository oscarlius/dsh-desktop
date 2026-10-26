import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadDesktopUpdate } from '../src/update-download.ts'
import type { PublishedCompanyRelease } from '../src/company-update-check.ts'

const roots: string[] = []
const artifact = Buffer.alloc(512)
artifact.write('MZ'); artifact.writeUInt32LE(128, 0x3c); artifact.write('PE\0\0', 128)
const release: PublishedCompanyRelease = { status: 'update-available', version: '2.0.18-beta.4',
  releaseNotes: 'Update', downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/dsh/companytest/2.0.18-beta.4/P7-DSH-Company-Test-2.0.18-beta.4-x64-Setup.exe',
  sha256: createHash('sha256').update(artifact).digest('hex') }

async function options() {
  const root = await mkdtemp(join(tmpdir(), 'p7-update-download-')); roots.push(root)
  return { platform: 'win32' as const, version: release.version, companyRelease: release,
    destinationPath: join(root, 'setup.exe'),
    request: vi.fn(async () => ({ response: new Response(artifact), finalUrl: release.downloadUrl })) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('company installer transport', () => {
  it('downloads the fixed company origin on port 8090, omits credentials, pins hash and reports progress', async () => {
    const config = await options(); const progress = vi.fn()
    expect(await downloadDesktopUpdate({ ...config, onProgress: progress })).toBe(config.destinationPath)
    expect(await readFile(config.destinationPath)).toEqual(artifact)
    expect(config.request).toHaveBeenCalledWith(release.downloadUrl, expect.objectContaining({ redirect: 'error', credentials: 'omit' }))
    expect(progress).toHaveBeenCalledWith(artifact.byteLength, undefined)
  })
  it('rejects changed bytes and removes partial files', async () => {
    const config = await options()
    await expect(downloadDesktopUpdate({ ...config, companyRelease: { ...release, sha256: '0'.repeat(64) } })).rejects.toThrow('digest')
    expect(await readdir(roots[0]!)).toEqual([])
  })
  it('requires a company digest even when no optional upstream digest is supplied', async () => {
    const config = await options()
    await expect(downloadDesktopUpdate({ ...config, companyRelease: { ...release, sha256: '' } })).rejects.toThrow('digest')
    expect(config.request).not.toHaveBeenCalled()
  })
  it('rejects redirects, Full installers, version drift, unsupported platforms, and foreign URLs', async () => {
    const config = await options()
    await expect(downloadDesktopUpdate({ ...config, request: async () => ({ response: new Response(artifact), finalUrl: 'https://attacker.example/setup.exe' }) })).rejects.toThrow()
    await expect(downloadDesktopUpdate({ ...config, platform: 'darwin' })).rejects.toThrow('platform or version')
    await expect(downloadDesktopUpdate({ ...config, version: '2.0.18-beta.5' })).rejects.toThrow('platform or version')
    await expect(downloadDesktopUpdate({ ...config, companyRelease: { ...release, downloadUrl: 'https://attacker.example/setup.exe' } })).rejects.toThrow()
    await expect(downloadDesktopUpdate({ ...config, companyRelease: { ...release,
      downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/dsh/companytest/2.0.18-beta.4/P7-DSH-Company-Full-2.0.18-beta.4-x64-Setup.exe' } })).rejects.toThrow()
    await expect(downloadDesktopUpdate({ ...config, request: async () => ({ response: new Response(artifact),
      finalUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/dsh/companytest/2.0.18-beta.5/P7-DSH-Company-Test-2.0.18-beta.5-x64-Setup.exe' }) })).rejects.toThrow()
    expect(config.request).not.toHaveBeenCalled()
  })
})
