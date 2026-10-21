import { EventEmitter } from 'node:events'
import type { NsisUpdater, UpdateCheckResult } from 'electron-updater'
import { describe, expect, it, vi } from 'vitest'
import { assertCompanyUpdateInfo, COMPANY_UPDATER_FEED, downloadCompanyDifferentialUpdate } from '../src/company-differential-update.ts'
import type { PublishedCompanyRelease } from '../src/company-update-check.ts'
import beforePack from '../scripts/company-update-before-pack.ts'

const release: PublishedCompanyRelease = { status: 'update-available', version: '2.0.18-beta.4', releaseNotes: '',
  downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/dsh/companytest/2.0.18-beta.4/P7-DSH-Company-Test-2.0.18-beta.4-x64-Setup.exe',
  sha256: 'a'.repeat(64), sha512: Buffer.alloc(64, 1).toString('base64'), size: 512, updaterFeedUrl: COMPANY_UPDATER_FEED }
function result(): UpdateCheckResult {
  const info = { version: release.version, releaseDate: '2026-10-21T00:00:00Z', path: release.downloadUrl, sha512: release.sha512!,
    files: [{ url: release.downloadUrl, size: release.size!, sha512: release.sha512! }] }
  return { isUpdateAvailable: true, updateInfo: info, versionInfo: info, cancellationToken: { cancel: vi.fn() } as never }
}
function updater(value: UpdateCheckResult | null = result()) {
  return Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(async () => value), downloadUpdate: vi.fn(async (_token?: unknown) => ['C:/private/pending/update.exe']),
    autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, allowPrerelease: false,
    disableWebInstaller: false, disableDifferentialDownload: true,
  })
}
describe('company differential updater', () => {
  it('pins the manifest and uses upstream differential/fallback download without implicit installation', async () => {
    const backend = updater(); const onProgress = vi.fn()
    backend.downloadUpdate.mockImplementation(async () => { backend.emit('download-progress', { transferred: 64, total: 512 }); return ['C:/private/pending/update.exe'] })
    expect(await downloadCompanyDifferentialUpdate({ release, signal: new AbortController().signal, onProgress,
      createUpdater: async () => backend as unknown as NsisUpdater })).toBe('C:/private/pending/update.exe')
    expect(backend).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, disableDifferentialDownload: false, disableWebInstaller: true, allowDowngrade: false })
    expect(onProgress).toHaveBeenCalledWith(64, 512)
    expect(backend.listenerCount('download-progress')).toBe(0)
  })
  it.each(['version', 'url', 'digest', 'size', 'extra-file', 'web-package'] as const)('rejects a feed changing %s after confirmation', async change => {
    const value = result()
    if (change === 'version') Object.assign(value.updateInfo, { version: '2.0.18-beta.5' })
    if (change === 'url') value.updateInfo.files[0]!.url = 'https://attacker.example/setup.exe'
    if (change === 'digest') Object.assign(value.updateInfo.files[0]!, { sha512: Buffer.alloc(64, 2).toString('base64') })
    if (change === 'size') value.updateInfo.files[0]!.size = 999
    if (change === 'extra-file') value.updateInfo.files.push({ ...value.updateInfo.files[0]! })
    if (change === 'web-package') Object.assign(value.updateInfo, { packages: {} })
    const backend = updater(value)
    await expect(downloadCompanyDifferentialUpdate({ release, signal: new AbortController().signal, onProgress: () => {}, createUpdater: async () => backend as unknown as NsisUpdater })).rejects.toThrow()
    expect(backend.downloadUpdate).not.toHaveBeenCalled()
  })
  it('cancels the real updater token and never returns a late download after disposal', async () => {
    const controller = new AbortController(); const checked = result(); const backend = updater(checked)
    backend.downloadUpdate.mockImplementation(async () => { controller.abort(); return ['C:/private/pending/update.exe'] })
    await expect(downloadCompanyDifferentialUpdate({ release, signal: controller.signal, onProgress: () => {}, createUpdater: async () => backend as unknown as NsisUpdater })).rejects.toThrow()
    expect(checked.cancellationToken!.cancel).toHaveBeenCalledOnce()
  })
  it('rejects a feed on another origin before allowing it to supply an installer', () => {
    expect(() => assertCompanyUpdateInfo(result(), { ...release, updaterFeedUrl: 'https://attacker.example/' })).toThrow()
  })
  it('gives company NSIS and updater the same isolated baseline-cache identity', () => {
    const appInfo = { updaterCacheDirName: 'dsh-plugin-desktop-updater' }
    beforePack({ packager: { appInfo, config: { extraMetadata: { dshDesktopFlavor: 'companytest' } } } })
    expect(appInfo.updaterCacheDirName).toBe('p7-dsh-companytest-updater')
    const validation = { updaterCacheDirName: 'old' }
    beforePack({ packager: { appInfo: validation, config: { extraMetadata: { dshDesktopFlavor: 'companytest', dshDesktopValidationCacheName: 'p7-dsh-validation-abcd-updater' } } } })
    expect(validation.updaterCacheDirName).toBe('p7-dsh-validation-abcd-updater')
  })
})
