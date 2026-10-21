import { describe, expect, it, vi } from 'vitest'
import type { ModelConfigV1, P7Snapshot } from '../src/contracts.js'
import type { P7Client } from '../src/p7-client.js'
import { P7ClientError } from '../src/p7-client.js'
import { createSyncController, type SnapshotStore, type Timer } from '../src/sync-controller.js'
import { config } from './fixtures/config.js'

const modelConfig = () => config() as ModelConfigV1
const createTimer = (): Timer & { delays: number[] } => ({ delays: [], setTimeout(_callback, delay) { this.delays.push(delay); return this.delays.length }, clearTimeout: vi.fn() })
const createStore = (): SnapshotStore & { value?: P7Snapshot; saves: P7Snapshot[] } => ({ saves: [], load() { return this.value }, save(snapshot) { this.saves.push(snapshot); this.value = snapshot }, clear() { delete this.value } })
const clientResult = (client: P7Client['fetchConfig']): P7Client => ({ fetchConfig: client })
const connection = { origin: 'https://p7.example', key: 'p7k_secret', credentialRef: 'p7-key' }

describe('P7 sync controller', () => {
  it('commits snapshot only after apply succeeds and schedules normal polling', async () => {
    const store = createStore(); const timer = createTimer(); const apply = vi.fn(async () => {})
    const controller = createSyncController({ client: clientResult(vi.fn(async () => ({ kind: 'snapshot' as const, config: modelConfig(), etag: '"revision-1"' }))), apply, store, timer, now: () => 42 })
    controller.start()
    await controller.connect(connection)
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ revision: 'revision-1' }), connection, expect.any(Function))
    expect(store.saves).toHaveLength(1)
    expect(controller.getState()).toMatchObject({ status: 'ready', revision: 'revision-1', lastSuccessAt: 42 })
    expect(timer.delays).toContain(60_000)
  })
  it('does not commit when apply fails', async () => {
    const store = createStore()
    const controller = createSyncController({ client: clientResult(async () => ({ kind: 'snapshot', config: modelConfig(), etag: '"revision-1"' })), apply: async () => { throw new Error('apply failed') }, store, timer: createTimer() })
    await controller.connect(connection)
    expect(store.saves).toHaveLength(0)
    expect(controller.getState().status).toBe('idle')
  })
  it('retries a failed cached restore before accepting a subsequent 304', async () => {
    const store = createStore()
    store.value = { config: modelConfig(), etag: '"revision-1"', appliedAt: 42 }
    const timer = createTimer()
    let retry: (() => void) | undefined
    timer.setTimeout = (callback, delay) => { timer.delays.push(delay); retry = callback; return timer.delays.length }
    const apply = vi.fn().mockRejectedValueOnce(Object.assign(new Error('concurrent settings edit'), { code: 'SETTINGS_CONFLICT' })).mockResolvedValue(undefined)
    const fetchConfig = vi.fn(async () => ({ kind: 'not-modified' as const }))
    const controller = createSyncController({ client: clientResult(fetchConfig), apply, store, timer })
    controller.start()
    await controller.restore(connection)
    expect(controller.getState()).toMatchObject({ status: 'stale', error: 'network' })
    expect(fetchConfig).not.toHaveBeenCalled()
    expect(timer.delays).toEqual([60_000])
    retry!()
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'))
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenLastCalledWith(store.value!.config, connection, expect.any(Function))
    expect(fetchConfig).toHaveBeenCalledTimes(1)
    expect(fetchConfig).toHaveBeenCalledWith(expect.objectContaining({ etag: '"revision-1"', hasSnapshot: true }))
    controller.stop()
  })
  it('retains a valid snapshot and uses capped exponential retry for network errors', async () => {
    const store = createStore()
    const timer = createTimer()
    const fetchConfig = vi.fn().mockResolvedValueOnce({ kind: 'snapshot' as const, config: modelConfig(), etag: '"revision-1"' }).mockRejectedValue(new P7ClientError('network'))
    const controller = createSyncController({ client: clientResult(fetchConfig), apply: async () => {}, store, timer })
    await controller.connect(connection)
    controller.start(); await controller.sync(); await controller.sync(); await controller.sync(); await controller.sync()
    expect(controller.getState()).toMatchObject({ status: 'stale', error: 'network' })
    expect(timer.delays).toEqual(expect.arrayContaining([60_000, 120_000, 240_000, 300_000]))
  })
  it('invalidates a late response after disconnect without applying or storing it', async () => {
    let resolvePending!: (value: { kind: 'snapshot'; config: ModelConfigV1; etag: string }) => void
    const pending = new Promise<{ kind: 'snapshot'; config: ModelConfigV1; etag: string }>(resolve => { resolvePending = resolve })
    const store = createStore(); const apply = vi.fn(async () => {})
    const controller = createSyncController({ client: clientResult(async () => pending), apply, store, timer: createTimer() })
    const connecting = controller.connect(connection)
    await Promise.resolve()
    await controller.disconnect()
    resolvePending({ kind: 'snapshot', config: modelConfig(), etag: '"revision-1"' })
    await connecting
    expect(apply).toHaveBeenCalledWith(undefined, connection, expect.any(Function))
    expect(apply).toHaveBeenCalledTimes(2)
    expect(store.saves).toHaveLength(0)
  })
  it('removes managed models and blocks future calls after an auth failure', async () => {
    const store = createStore(); const apply = vi.fn(async () => {})
    const controller = createSyncController({ client: clientResult(async () => { throw new P7ClientError('forbidden', 403) }), apply, store, timer: createTimer() })
    await controller.connect(connection)
    expect(apply).toHaveBeenCalledWith(undefined, connection, expect.any(Function))
    expect(controller.getState()).toMatchObject({ status: 'reauth-required', error: 'forbidden' })
    await controller.sync()
    expect(apply).toHaveBeenCalledTimes(2)
  })
  it('fails closed when persistence and rollback both fail', async () => {
    const timer = createTimer()
    const store: SnapshotStore = { load: () => undefined, save: async () => { throw new Error('disk failed') }, clear: async () => {} }
    const recovery = vi.fn(async () => {})
    let calls = 0
    const apply = vi.fn(async () => { calls++; if (calls === 3) throw new Error('rollback failed') })
    const controller = createSyncController({ client: clientResult(async () => ({ kind: 'snapshot', config: modelConfig(), etag: '"revision-1"' })), apply, store, timer, onRecoveryFailure: recovery })
    controller.start()
    await controller.connect({ ...connection })
    expect(controller.getState()).toEqual({ status: 'recovery-required', error: 'recovery-required' })
    expect(recovery).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rollback-failed', connection: expect.objectContaining({ key: '' }) }))
    expect(timer.delays).toHaveLength(0)
    await controller.sync()
    expect(recovery).toHaveBeenCalledTimes(1)
  })
})
