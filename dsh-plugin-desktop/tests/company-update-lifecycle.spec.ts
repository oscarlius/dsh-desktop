import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompanyReleaseResult } from '../src/company-update-check.ts'
import { startCompanyUpdateLifecycle } from '../src/company-update-lifecycle.ts'
import type { DesktopTrayItem } from '../src/runtime.ts'

const release = (overrides: Partial<Exclude<CompanyReleaseResult, { status: 'not-published' }>> = {}) => ({
  status: 'update-available' as const,
  version: '2.1.0',
  releaseNotes: 'Changes',
  downloadUrl: 'https://p7.example.test/DSH-2.1.0.exe',
  sha256: 'a'.repeat(64),
  ...overrides,
})

interface Harness {
  readonly statePath: string
  readonly check: ReturnType<typeof vi.fn>
  readonly confirm: ReturnType<typeof vi.fn>
  readonly download: ReturnType<typeof vi.fn>
  readonly notify: ReturnType<typeof vi.fn>
  readonly reportDownloadError: ReturnType<typeof vi.fn>
  readonly refresh: ReturnType<typeof vi.fn>
  readonly disposeTray: ReturnType<typeof vi.fn>
  readonly tray: DesktopTrayItem
  readonly lifecycle: ReturnType<typeof startCompanyUpdateLifecycle>
}

async function createHarness(options: {
  readonly responses?: readonly (CompanyReleaseResult | Error)[]
  readonly statePath?: string
  readonly confirm?: (value: CompanyReleaseResult | null) => Promise<boolean>
  readonly download?: (value: Exclude<CompanyReleaseResult, { status: 'not-published' }>, signal: AbortSignal, progress: (received: number, total: number | undefined) => void) => Promise<void>
  readonly packaged?: boolean
  readonly enabled?: boolean
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-company-update-'))
  const statePath = options.statePath ?? join(root, 'state.json')
  const responses = [...(options.responses ?? [release()])]
  const check = vi.fn(async () => {
    const next = responses.shift() ?? { status: 'not-published' as const }
    if (next instanceof Error) throw next
    return next
  })
  const confirm = vi.fn(options.confirm ?? (async () => false))
  const download = vi.fn(options.download ?? (async () => {}))
  const notify = vi.fn()
  const reportDownloadError = vi.fn(async () => {})
  const refresh = vi.fn()
  const disposeTray = vi.fn()
  let tray: DesktopTrayItem | undefined
  const lifecycle = startCompanyUpdateLifecycle({
    isPackaged: options.packaged ?? true,
    canDownload: true,
    enabled: options.enabled ?? true,
    initialDelayMs: 1,
    intervalMs: 60_000,
    requestTimeoutMs: 1_000,
    statePath,
    locale: () => 'en',
    registerTrayItem: item => {
      tray = item
      return { refresh, dispose: disposeTray }
    },
    check,
    confirm,
    download,
    notify,
    reportDownloadError,
  })
  if (tray === undefined) throw new Error('company tray item was not registered')
  return { statePath, check, confirm, download, notify, reportDownloadError, refresh, disposeTray, tray, lifecycle }
}

afterEach(() => vi.useRealTimers())

describe('company update lifecycle', () => {
  it('announces each available version once and persists the background reminder', async () => {
    vi.useFakeTimers()
    const first = await createHarness({ responses: [release(), release()] })
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(first.notify).toHaveBeenCalledOnce())
    expect(first.notify).toHaveBeenCalledOnce()
    expect(first.confirm).toHaveBeenCalledOnce()
    await first.lifecycle.dispose()
    expect(JSON.parse(await readFile(first.statePath, 'utf8'))).toEqual({ version: 1, lastNotifiedVersion: '2.1.0' })

    const second = await createHarness({ statePath: first.statePath, responses: [release()] })
    await vi.advanceTimersByTimeAsync(1)
    expect(second.notify).not.toHaveBeenCalled()
    expect(second.confirm).not.toHaveBeenCalled()
    await second.lifecycle.dispose()
  })

  it('manually confirms, pins the release again, and downloads only the verified artifact', async () => {
    const harness = await createHarness({ responses: [release(), release()], confirm: async value => value?.status === 'update-available' })
    await harness.lifecycle.checkNow()
    expect(harness.confirm).toHaveBeenCalledWith(release())
    expect(harness.download).toHaveBeenCalledOnce()
    expect(harness.download.mock.calls[0]?.[0]).toEqual(release())
    expect(harness.tray.id).toBe('check-for-updates')
    expect(harness.refresh).toHaveBeenCalled()
    await harness.lifecycle.dispose()
  })

  it.each([
    ['withdrawn', { status: 'not-published' as const }],
    ['changed digest', release({ sha256: 'b'.repeat(64) })],
  ])('does not download when recheck is %s', async (_name, second) => {
    const harness = await createHarness({ responses: [release(), second], confirm: async () => true })
    await harness.lifecycle.checkNow()
    expect(harness.download).not.toHaveBeenCalled()
    await harness.lifecycle.dispose()
  })

  it('reports failed downloads but suppresses cancellations', async () => {
    const failed = await createHarness({
      responses: [release(), release()], confirm: async () => true,
      download: async () => { throw new Error('network') },
    })
    await failed.lifecycle.checkNow()
    expect(failed.reportDownloadError).toHaveBeenCalledOnce()
    await failed.lifecycle.dispose()

    const cancelled = await createHarness({
      responses: [release(), release()], confirm: async () => true,
      download: (_release, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }),
    })
    const operation = cancelled.lifecycle.checkNow()
    await vi.waitFor(() => expect(cancelled.download).toHaveBeenCalledOnce())
    const disposing = cancelled.lifecycle.dispose()
    await Promise.all([operation, disposing])
    expect(cancelled.reportDownloadError).not.toHaveBeenCalled()
  })

  it('shows manual no-release and failed-check results but keeps background checks silent', async () => {
    const manual = await createHarness({ responses: [{ status: 'not-published' }] })
    await manual.lifecycle.checkNow()
    expect(manual.confirm).toHaveBeenCalledWith({ status: 'not-published' })
    await manual.lifecycle.dispose()

    const failedManual = await createHarness({ responses: [new Error('offline')] })
    await failedManual.lifecycle.checkNow()
    expect(failedManual.confirm).toHaveBeenCalledWith(null)
    await failedManual.lifecycle.dispose()

    vi.useFakeTimers()
    const background = await createHarness({ responses: [{ status: 'not-published' }, new Error('offline')] })
    await vi.advanceTimersByTimeAsync(60_001)
    expect(background.confirm).not.toHaveBeenCalled()
    expect(background.notify).not.toHaveBeenCalled()
    await background.lifecycle.dispose()
  })

  it('aborts a timed-out check and reports it only through the manual result flow', async () => {
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    const harness = await createHarness({ responses: [] })
    ;(harness.check as ReturnType<typeof vi.fn>).mockImplementationOnce((signal: AbortSignal) => new Promise<CompanyReleaseResult>((_resolve, reject) => {
      observedSignal = signal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const checking = harness.lifecycle.checkNow()
    await vi.advanceTimersByTimeAsync(1_000)
    await checking
    expect(observedSignal?.aborted).toBe(true)
    expect(harness.confirm).toHaveBeenCalledWith(null)
    await harness.lifecycle.dispose()
  })

  it('shares an automatic confirmation with a concurrent notification click', async () => {
    vi.useFakeTimers()
    let resolveConfirm!: (value: boolean) => void
    const harness = await createHarness({
      responses: [release(), release()],
      confirm: () => new Promise(resolve => { resolveConfirm = resolve }),
    })
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledOnce())
    const onClick = harness.notify.mock.calls[0]?.[1]
    onClick?.()
    resolveConfirm(false)
    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledOnce())
    await harness.lifecycle.dispose()
  })

  it.each([
    ['a newer version', release({ version: '2.2.0', downloadUrl: 'https://p7.example.test/DSH-2.2.0.exe' })],
    ['a replacement digest', release({ sha256: 'b'.repeat(64) })],
  ])('does not reuse an accepted artifact confirmation when a notification click sees %s', async (_name, replacement) => {
    vi.useFakeTimers()
    const resolutions: Array<(value: boolean) => void> = []
    const harness = await createHarness({
      responses: [release(), replacement, replacement],
      confirm: () => new Promise(resolve => { resolutions.push(resolve) }),
    })
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(harness.notify).toHaveBeenCalledOnce())
    harness.notify.mock.calls[0]?.[1]()
    await vi.waitFor(() => expect(harness.check).toHaveBeenCalledTimes(2))
    expect(harness.confirm).toHaveBeenCalledOnce()

    resolutions[0]?.(false)
    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(2))
    expect(harness.confirm.mock.calls[0]?.[0]).toEqual(release())
    expect(harness.confirm.mock.calls[1]?.[0]).toEqual(replacement)
    resolutions[1]?.(true)
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce())
    expect(harness.download.mock.calls[0]?.[0]).toEqual(replacement)
    await harness.lifecycle.dispose()
  })

  it('allows a retry after a download failure', async () => {
    let attempts = 0
    const harness = await createHarness({
      responses: [release(), release(), release(), release()], confirm: async () => true,
      download: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('network')
      },
    })
    await harness.lifecycle.checkNow()
    await harness.lifecycle.checkNow()
    expect(harness.download).toHaveBeenCalledTimes(2)
    expect(harness.reportDownloadError).toHaveBeenCalledOnce()
    await harness.lifecycle.dispose()
  })

  it('presents throttled download progress as percent and MiB', async () => {
    let complete!: () => void
    const harness = await createHarness({
      responses: [release(), release()], confirm: async () => true,
      download: async (_release, _signal, progress) => {
        progress(512 * 1024, 1024 * 1024)
        progress(513 * 1024, 1024 * 1024)
        await new Promise<void>(resolve => { complete = resolve })
      },
    })
    const operation = harness.lifecycle.checkNow()
    await vi.waitFor(() => expect(harness.download).toHaveBeenCalledOnce())
    expect(harness.tray.label()).toContain('50% · 0.5/1.0 MiB')
    complete()
    await operation
    await harness.lifecycle.dispose()
  })

  it('cancels scheduled work and ignores a confirmation that returns after disposal', async () => {
    vi.useFakeTimers()
    let resolveConfirm!: (value: boolean) => void
    const harness = await createHarness({
      responses: [release()],
      confirm: () => new Promise(resolve => { resolveConfirm = resolve }),
    })
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledOnce())
    const disposing = harness.lifecycle.dispose()
    resolveConfirm(true)
    await disposing
    expect(harness.download).not.toHaveBeenCalled()
    expect(harness.disposeTray).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(harness.check).toHaveBeenCalledOnce()
  })
})
