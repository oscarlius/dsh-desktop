/** Official NSIS blockmap downloader, bounded to the company release the user accepted. */
import type { NsisUpdater, UpdateCheckResult } from 'electron-updater'
import { companyInstallerUrl, type PublishedCompanyRelease } from './company-update-check.ts'
import { DEFAULT_P7_PUBLIC_ORIGIN } from 'dsh-plugin-p7-company-models/defaults'

export const COMPANY_UPDATER_FEED = `${DEFAULT_P7_PUBLIC_ORIGIN}/v1/desktop/releases/companytest/`
export const COMPANY_UPDATER_CACHE = 'p7-dsh-companytest-updater'

export interface CompanyDifferentialOptions {
  readonly release: PublishedCompanyRelease
  readonly signal: AbortSignal
  readonly onProgress: (received: number, total: number | undefined) => void
  readonly log?: (message: string) => void
  /** Tests may supply a real updater with an isolated AppAdapter/cache and HTTP executor. */
  readonly createUpdater?: () => Promise<NsisUpdater>
}

/** A mutable feed cannot silently change the version, file or digest being downloaded. */
export function assertCompanyUpdateInfo(result: UpdateCheckResult | null, release: PublishedCompanyRelease): void {
  const info = result?.updateInfo
  const file = info?.files?.[0]
  if (release.updaterFeedUrl !== COMPANY_UPDATER_FEED || !release.sha512 || !release.size
    || !result?.isUpdateAvailable || info?.version !== release.version || info.files.length !== 1
    || file === undefined || ('packages' in info && info.packages !== undefined)
    || companyInstallerUrl(new URL(file.url, COMPANY_UPDATER_FEED).href, release.version) !== release.downloadUrl
    || file.sha512 !== release.sha512 || file.size !== release.size) {
    throw new Error('P7 differential manifest changed after confirmation')
  }
}

export async function createCompanyNsisUpdater(): Promise<NsisUpdater> {
  const { NsisUpdater } = await import('electron-updater')
  return new NsisUpdater({ provider: 'generic', url: COMPANY_UPDATER_FEED, channel: 'latest', useMultipleRangeRequest: false, timeout: 15_000 })
}

/** The upstream downloader automatically falls back to a verified full download on delta failure. */
export async function downloadCompanyDifferentialUpdate(options: CompanyDifferentialOptions): Promise<string> {
  options.signal.throwIfAborted()
  const updater = await (options.createUpdater ?? createCompanyNsisUpdater)()
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowDowngrade = false
  updater.allowPrerelease = true
  updater.disableWebInstaller = true
  updater.disableDifferentialDownload = false
  updater.logger = {
    info: message => { options.log?.(String(message)) },
    warn: message => { options.log?.(String(message)) },
    error: message => { options.log?.(String(message)) },
  }
  // EventEmitter errors are also propagated by the returned promises; retain a listener.
  const error = (): void => {}
  const progress = (value: { transferred: number, total: number }): void => options.onProgress(value.transferred, value.total)
  updater.on('error', error)
  updater.on('download-progress', progress)
  let check: UpdateCheckResult | null = null
  const abort = (): void => { check?.cancellationToken?.cancel() }
  options.signal.addEventListener('abort', abort, { once: true })
  try {
    check = await updater.checkForUpdates()
    options.signal.throwIfAborted()
    assertCompanyUpdateInfo(check, options.release)
    const files = await updater.downloadUpdate(check?.cancellationToken)
    options.signal.throwIfAborted()
    if (files.length !== 1 || files[0] === undefined) throw new Error('P7 updater returned an invalid installer')
    return files[0]
  } finally {
    options.signal.removeEventListener('abort', abort)
    updater.off('error', error)
    updater.off('download-progress', progress)
  }
}
