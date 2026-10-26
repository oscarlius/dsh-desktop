/** Host-only bridge from the Next updater lifecycle to the company release contract. */
import { join } from 'node:path'
import { downloadDesktopUpdate, type UpdateArtifactRequest } from './update-download.ts'
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

export function createCompanyUpdateAdapter(options: { request: UpdateRequest, artifactRequest: UpdateArtifactRequest, log(error: unknown): void }): CompanyUpdateAdapter {
  return {
    identity: COMPANY_UPDATE_IDENTITY,
    check: (version, signal) => checkCompanyRelease(version, options.request, signal),
    async download(release, destination, signal, progress) {
      if (release.updaterFeedUrl && release.sha512 && release.size) {
        try { return await downloadCompanyDifferentialUpdate({ release, signal, onProgress: progress, log: value => options.log(value) }) }
        catch (error) {
          if (signal.aborted) throw error
          // The fallback is the same published, credential-free update EXE; never the bootstrap Full installer.
          options.log(`Company delta failed; downloading the pinned update installer: ${String(error)}`)
        }
      }
      return downloadDesktopUpdate({ companyRelease: release, platform: 'win32', version: release.version,
        destinationPath: join(destination, `P7-DSH-Company-Test-${release.version}-x64-Setup.exe`),
        request: options.artifactRequest, expectedSha256: release.sha256, signal, onProgress: progress })
    },
    verify: verifyCompanyInstaller,
  }
}
