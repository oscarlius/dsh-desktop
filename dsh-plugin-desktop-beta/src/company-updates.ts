/** Host-only bridge from the Next updater lifecycle to the company release contract. */
import { join } from 'node:path'
import { assertInstallerDigest, downloadDesktopUpdate, type UpdateArtifactRequest } from './update-download.ts'
import type { UpdateRequest } from '../../dsh-plugin-desktop/src/update-checker.ts'
import { checkCompanyRelease, type CompanyReleaseResult, type PublishedCompanyRelease } from './company-update-check.ts'
import { COMPANY_UPDATER_CACHE, downloadCompanyDifferentialUpdate } from './company-differential-update.ts'
import { verifyCompanyInstaller } from './company-update-installer.ts'

export const COMPANY_UPDATE_IDENTITY = Object.freeze({ appId: 'ai.deepseek.dsh.desktop.companytest', productName: 'P7 DSH Company Test', releaseChannel: 'companytest' as const, cacheName: COMPANY_UPDATER_CACHE })
export interface CompanyUpdateAdapter {
  readonly identity: typeof COMPANY_UPDATE_IDENTITY
  check(version: string, signal: AbortSignal): Promise<CompanyReleaseResult>
  download(release: PublishedCompanyRelease, destination: string, signal: AbortSignal, progress: (received: number, total: number | undefined) => void): Promise<string>
  verify(path: string, release: PublishedCompanyRelease, signal: AbortSignal): Promise<void>
}

export function createCompanyUpdateAdapter(options: { platform?: string, request: UpdateRequest, artifactRequest: UpdateArtifactRequest, log(error: unknown): void }): CompanyUpdateAdapter {
  const platform = options.platform === 'darwin' ? 'darwin' : 'win32'
  return {
    identity: COMPANY_UPDATE_IDENTITY,
    check: (version, signal) => checkCompanyRelease(version, options.request, signal, platform),
    async download(release, destination, signal, progress) {
      if ((release.platform ?? 'win32') !== platform) throw new Error('Company release platform does not match this client')
      if (platform === 'win32' && release.updaterFeedUrl && release.sha512 && release.size) {
        try { return await downloadCompanyDifferentialUpdate({ release, signal, onProgress: progress, log: value => options.log(value) }) }
        catch (error) {
          if (signal.aborted) throw error
          // The fallback is the same published, credential-free update EXE; never the bootstrap Full installer.
          options.log(`Company delta failed; downloading the pinned update installer: ${String(error)}`)
        }
      }
      return downloadDesktopUpdate({ companyRelease: release, platform, version: release.version,
        destinationPath: join(destination, platform === 'darwin' ? `P7-DSH-Company-Test-${release.version}-universal.dmg` : `P7-DSH-Company-Test-${release.version}-x64-Setup.exe`),
        request: options.artifactRequest, expectedSha256: release.sha256, signal, onProgress: progress })
    },
    async verify(path, release, signal) {
      if (platform === 'win32') return verifyCompanyInstaller(path, release, signal)
      signal.throwIfAborted()
      await assertInstallerDigest(path, release.sha256)
      signal.throwIfAborted()
      // Bundle identity, distribution and signing checks run in native prepare().
    },
  }
}
