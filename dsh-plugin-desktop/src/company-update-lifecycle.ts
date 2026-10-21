/** Company-release polling, confirmation, download, and generation cleanup. */

import { open } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CompanyReleaseResult } from './company-update-check.ts'
import type {
  DesktopLocale,
  DesktopNotification,
  DesktopTrayItem,
  DesktopTrayItemRegistration,
} from './runtime.ts'

const MAX_STATE_BYTES = 4 * 1024
const PROGRESS_REFRESH_INTERVAL_MS = 250

export type PublishedCompanyRelease = Exclude<CompanyReleaseResult, { status: 'not-published' }>

/** Dependencies owned by the company Desktop update integration. */
export interface CompanyUpdateLifecycleOptions {
  readonly isPackaged: boolean
  readonly canDownload: boolean
  readonly enabled: boolean
  readonly initialDelayMs: number
  readonly intervalMs: number
  readonly requestTimeoutMs: number
  readonly statePath: string
  readonly locale: () => DesktopLocale
  readonly registerTrayItem: (item: DesktopTrayItem) => DesktopTrayItemRegistration
  readonly check: (signal: AbortSignal) => Promise<CompanyReleaseResult>
  readonly confirm: (release: CompanyReleaseResult | null) => Promise<boolean>
  readonly download: (
    release: PublishedCompanyRelease,
    signal: AbortSignal,
    onProgress: (received: number, total: number | undefined) => void,
  ) => Promise<void>
  readonly notify: (notification: DesktopNotification, onClick: () => void) => void
  readonly reportDownloadError: () => Promise<void>
}

/** Generation-scoped company update control surface. */
export interface CompanyUpdateLifecycle {
  checkNow(): Promise<void>
  dispose(): Promise<void>
}

interface CompanyUpdateState {
  readonly version: 1
  readonly lastNotifiedVersion?: string
}

const EMPTY_STATE: CompanyUpdateState = { version: 1 }

/** Start isolated company-release lifecycle work for one Desktop generation. */
export function startCompanyUpdateLifecycle(options: CompanyUpdateLifecycleOptions): CompanyUpdateLifecycle {
  return new CompanyUpdateLifecycleOwner(options)
}

class CompanyUpdateLifecycleOwner implements CompanyUpdateLifecycle {
  private disposed = false
  private disposeTask: Promise<void> | undefined
  private checking = false
  private available: PublishedCompanyRelease | undefined
  private downloading: PublishedCompanyRelease | undefined
  private progress: { received: number, total: number | undefined } | undefined
  private progressPercent: number | undefined
  private lastProgressRefreshAt = 0
  private state: CompanyUpdateState = EMPTY_STATE
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private requestTimer: ReturnType<typeof setTimeout> | undefined
  private checkController: AbortController | undefined
  private downloadController: AbortController | undefined
  private checkTask: Promise<CompanyReleaseResult | null> | undefined
  private manualTask: Promise<void> | undefined
  private confirmation: { readonly release: CompanyReleaseResult | null, readonly task: Promise<boolean> } | undefined
  private downloadTask: Promise<void> | undefined
  private readonly stateReady: Promise<void>
  private readonly registration: DesktopTrayItemRegistration

  constructor(private readonly options: CompanyUpdateLifecycleOptions) {
    this.stateReady = this.loadState()
    this.registration = options.registerTrayItem({
      id: 'check-for-updates', group: 'status', order: 20,
      label: () => this.trayLabel(),
      invoke: () => this.checkNow(),
    })
    if (options.isPackaged && options.enabled) this.schedule(options.initialDelayMs)
  }

  checkNow(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.downloadTask !== undefined) return this.downloadTask
    this.manualTask ??= this.runManualCheck().catch(() => undefined).finally(() => { this.manualTask = undefined })
    return this.manualTask
  }

  dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.disposed = true
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    if (this.requestTimer !== undefined) clearTimeout(this.requestTimer)
    this.checkController?.abort()
    this.downloadController?.abort()
    this.registration.dispose()
    const pending: Promise<unknown>[] = [this.stateReady]
    if (this.checkTask !== undefined) pending.push(this.checkTask)
    this.disposeTask = Promise.allSettled(pending).then(() => {})
    return this.disposeTask
  }

  private async loadState(): Promise<void> {
    try {
      this.state = parseState(await readState(this.options.statePath))
    } catch (cause) {
      if (!isEnoent(cause)) {
        this.state = EMPTY_STATE
        if (!this.disposed) await this.persistState()
      }
    }
  }

  private async persistState(): Promise<void> {
    try {
      await writeFileAtomic(this.options.statePath, `${JSON.stringify(this.state)}\n`, { mode: 0o600, dirMode: 0o700 })
    } catch {
      // Notification suppression is an optional convenience, never a startup failure.
    }
  }

  private startCheck(): Promise<CompanyReleaseResult | null> {
    if (this.checkTask !== undefined) return this.checkTask
    this.checking = true
    this.registration.refresh()
    const controller = new AbortController()
    this.checkController = controller
    const task = (async () => {
      this.requestTimer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs)
      try {
        return await this.options.check(controller.signal)
      } catch {
        return null
      }
    })().finally(() => {
      if (this.requestTimer !== undefined) clearTimeout(this.requestTimer)
      this.requestTimer = undefined
      if (this.checkController === controller) this.checkController = undefined
      this.checkTask = undefined
      this.checking = false
      this.registration.refresh()
    })
    this.checkTask = task
    return task
  }

  private observe(result: CompanyReleaseResult | null): PublishedCompanyRelease | undefined {
    if (this.disposed) return undefined
    const release = result?.status === 'update-available' && this.options.canDownload ? result : undefined
    // A transient request failure must not erase an update already visible in
    // the tray. A definite response, including an unpublished release, does.
    if (result !== null) this.available = release
    this.registration.refresh()
    return release
  }

  private async runManualCheck(): Promise<void> {
    const result = await this.startCheck()
    if (this.disposed) return
    const release = this.observe(result)
    const confirmed = await this.requestConfirmation(result)
    if (!confirmed || this.disposed || release === undefined || !this.options.canDownload) return
    await this.startDownload(release)
  }

  private async runBackgroundCheck(): Promise<void> {
    if (this.disposed || this.checkTask !== undefined || this.manualTask !== undefined || this.downloadTask !== undefined) return
    const release = this.observe(await this.startCheck())
    if (release === undefined || this.disposed || this.manualTask !== undefined || this.downloadTask !== undefined) return
    await this.announce(release)
  }

  private async announce(release: PublishedCompanyRelease): Promise<void> {
    await this.stateReady
    if (this.disposed || this.manualTask !== undefined || this.downloadTask !== undefined || this.state.lastNotifiedVersion === release.version) return
    this.state = { version: 1, lastNotifiedVersion: release.version }
    await this.persistState()
    if (this.disposed) return
    this.options.notify(updateAvailableNotification(this.options.locale(), release.version), () => { void this.checkNow() })
    const confirmed = await this.requestConfirmation(release)
    if (confirmed && !this.disposed && this.options.canDownload) await this.startDownload(release)
  }

  private startDownload(release: PublishedCompanyRelease): Promise<void> {
    if (this.downloadTask !== undefined) return this.downloadTask
    const task = this.downloadAfterPin(release).finally(() => {
      if (this.downloadTask === task) this.downloadTask = undefined
    })
    this.downloadTask = task
    return task
  }

  private requestConfirmation(release: CompanyReleaseResult | null): Promise<boolean> {
    const existing = this.confirmation
    if (existing !== undefined) {
      if (sameConfirmationRelease(existing.release, release)) return existing.task
      return existing.task.then(() => this.disposed ? false : this.requestConfirmation(release))
    }
    const task = Promise.resolve(this.options.confirm(release)).catch(() => false).finally(() => {
      if (this.confirmation?.task === task) this.confirmation = undefined
    })
    this.confirmation = { release, task }
    return task
  }

  private async downloadAfterPin(release: PublishedCompanyRelease): Promise<void> {
    // The prompt is attached to a particular artifact. Recheck it before any bytes move.
    const pinned = await this.startCheck()
    const confirmed = pinned?.status === 'update-available' && sameArtifact(pinned, release) ? pinned : undefined
    this.observe(pinned)
    if (this.disposed || confirmed === undefined || !this.options.canDownload) return
    const controller = new AbortController()
    this.downloadController = controller
    this.downloading = confirmed
    this.progress = { received: 0, total: undefined }
    this.registration.refresh()
    try {
      await this.options.download(confirmed, controller.signal, (received, total) => {
        if (this.disposed || this.downloadController !== controller) return
        this.progress = { received, total }
        const percent = total === undefined || total <= 0 ? undefined : Math.min(100, Math.floor((received * 100) / total))
        const now = Date.now()
        if (percent !== this.progressPercent || now - this.lastProgressRefreshAt >= PROGRESS_REFRESH_INTERVAL_MS) {
          this.progressPercent = percent
          this.lastProgressRefreshAt = now
          this.registration.refresh()
        }
      })
    } catch (cause) {
      if (!controller.signal.aborted && !this.disposed && !isAbort(cause)) await this.options.reportDownloadError()
    } finally {
      if (this.downloadController === controller) this.downloadController = undefined
      this.downloading = undefined
      this.progress = undefined
      this.progressPercent = undefined
      this.registration.refresh()
    }
  }

  private schedule(delayMs: number): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      void this.runBackgroundCheck().catch(() => undefined).finally(() => {
        if (!this.disposed) this.schedule(this.options.intervalMs)
      })
    }, delayMs)
  }

  private trayLabel(): string {
    if (this.downloading !== undefined) {
      const progress = this.progress
      const suffix = progress === undefined ? '' : formatProgress(progress)
      return this.options.locale() === 'zh'
        ? `正在下载 P7 更新 ${this.downloading.version}…${suffix}`
        : `Downloading P7 update ${this.downloading.version}…${suffix}`
    }
    if (this.available !== undefined) return this.options.locale() === 'zh'
      ? `P7 更新 ${this.available.version} 可用`
      : `P7 update ${this.available.version} available`
    return this.options.locale() === 'zh'
      ? (this.checking ? '正在检查 P7 更新…' : '检查 P7 更新…')
      : (this.checking ? 'Checking P7 updates…' : 'Check P7 updates…')
  }
}

function formatProgress(progress: { received: number, total: number | undefined }): string {
  const received = formatMiB(progress.received)
  if (progress.total === undefined || progress.total <= 0) return ` (${received} MiB)`
  const total = formatMiB(progress.total)
  const percent = Math.min(100, Math.floor((progress.received * 100) / progress.total))
  return ` (${percent}% · ${received}/${total} MiB)`
}

function formatMiB(bytes: number): string {
  return (Math.max(0, bytes) / (1024 * 1024)).toFixed(1)
}

function sameArtifact(left: PublishedCompanyRelease, right: PublishedCompanyRelease): boolean {
  return left.version === right.version && left.downloadUrl === right.downloadUrl && left.sha256 === right.sha256
    && left.updaterFeedUrl === right.updaterFeedUrl && left.sha512 === right.sha512 && left.size === right.size
}

function sameConfirmationRelease(left: CompanyReleaseResult | null, right: CompanyReleaseResult | null): boolean {
  if (left === null || right === null) return left === right
  if (left.status === 'not-published' || right.status === 'not-published') return left.status === right.status
  return sameArtifact(left, right)
}

function updateAvailableNotification(locale: DesktopLocale, version: string): DesktopNotification {
  return locale === 'zh'
    ? { title: 'P7 有可用更新', body: `版本 ${version} 已可下载。` }
    : { title: 'P7 Update Available', body: `Version ${version} is ready to download.` }
}

function parseState(text: string): CompanyUpdateState {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid company update state')
  const state = value as Record<string, unknown>
  if (state.version !== 1 || Object.keys(state).some(key => key !== 'version' && key !== 'lastNotifiedVersion')
    || (state.lastNotifiedVersion !== undefined && (typeof state.lastNotifiedVersion !== 'string' || state.lastNotifiedVersion.length > 256))) {
    throw new Error('invalid company update state')
  }
  return state.lastNotifiedVersion === undefined ? EMPTY_STATE : { version: 1, lastNotifiedVersion: state.lastNotifiedVersion }
}

async function readState(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_STATE_BYTES) throw new Error('company update state exceeds limit')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally { await handle.close() }
}

function isEnoent(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === 'ENOENT'
}

function isAbort(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError'
}
