import type { ModelConfigV1, P7Connection, P7Snapshot } from './contracts.js'
import type { P7Client } from './p7-client.js'
import { P7ClientError } from './p7-client.js'

export type SyncStatus = 'idle' | 'syncing' | 'ready' | 'stale' | 'reauth-required' | 'recovery-required'
export interface ManagedConnection extends P7Connection { credentialRef: string }
export interface SyncState { status: SyncStatus; revision?: string; lastSuccessAt?: number; error?: 'timeout' | 'network' | 'http' | 'invalid-response' | 'unauthorized' | 'forbidden' | 'recovery-required' }
export interface SnapshotStore { load(): P7Snapshot | undefined; save(snapshot: P7Snapshot): void | Promise<void>; clear(): void | Promise<void> }
export interface Timer { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void }
export interface SyncController { connect(connection: ManagedConnection): Promise<void>; restore(connection: ManagedConnection): Promise<void>; disconnect(): Promise<void>; start(): void; stop(): void; sync(): Promise<void>; getState(): SyncState }
const normalDelay = 60_000
const retryDelay = (failures: number) => [60_000, 120_000, 240_000, 300_000][Math.min(failures, 3)] ?? 300_000

export interface RecoveryFailureContext { reason: 'rollback-failed' | 'authorization-cleanup-failed' | 'disconnect-cleanup-failed'; error: unknown; connection: ManagedConnection }
export function createSyncController(options: { client: P7Client; apply(config: ModelConfigV1 | undefined, connection: ManagedConnection, isCurrent: () => boolean): void | Promise<void>; store: SnapshotStore; onAuthorizationFailure?(): void | Promise<void>; onRecoveryFailure?(context: RecoveryFailureContext): void | Promise<void>; timer?: Timer; now?: () => number }): SyncController {
  const timer = options.timer ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  const now = options.now ?? Date.now
  let connection: ManagedConnection | undefined; let snapshot = options.store.load(); let state: SyncState = snapshot ? { status: 'stale', revision: snapshot.config.revision, lastSuccessAt: snapshot.appliedAt } : { status: 'idle' }
  let generation = 0; let requestGeneration: number | undefined; let requestAbort: AbortController | undefined; let scheduled: unknown; let failures = 0; let started = false
  const current = (expected: number, target: ManagedConnection | undefined) => () => generation === expected && connection === target
  const cancelRequest = () => { requestAbort?.abort(); requestAbort = undefined; requestGeneration = undefined }
  const clearSchedule = () => { if (scheduled !== undefined) timer.clearTimeout(scheduled); scheduled = undefined }
  const schedule = (delay: number) => { if (!started || !connection) return; clearSchedule(); scheduled = timer.setTimeout(() => { scheduled = undefined; void sync() }, delay) }
  const clearError = () => { delete state.error }
  const errorState = (code: 'timeout' | 'network' | 'http' | 'invalid-response'): SyncState => snapshot ? { status: 'stale', revision: snapshot.config.revision, lastSuccessAt: snapshot.appliedAt, error: code } : { status: 'idle', error: code }
  const recoveryFailure = async (reason: RecoveryFailureContext['reason'], error: unknown, active: ManagedConnection) => {
    if (connection !== active) return
    const recoveryGeneration = ++generation
    const recoveryCurrent = current(recoveryGeneration, active)
    cancelRequest(); clearSchedule(); snapshot = undefined; active.key = ''
    try { await options.store.clear() } catch { /* fail closed even if persistence is unavailable */ }
    if (!recoveryCurrent()) return
    try { await options.apply(undefined, active, recoveryCurrent) } catch { /* callback owns final host cleanup */ }
    if (!recoveryCurrent()) return
    try { await options.onRecoveryFailure?.({ reason, error, connection: active }) } catch { /* state remains fail closed */ }
    if (recoveryCurrent()) state = { status: 'recovery-required', error: 'recovery-required' }
  }
  const authFailure = async (code: 'unauthorized' | 'forbidden', active: ManagedConnection) => {
    const authGeneration = ++generation; cancelRequest(); clearSchedule(); snapshot = undefined
    let cleanupError: unknown
    try { await options.store.clear() } catch (error) { cleanupError = error }
    if (!current(authGeneration, active)()) return
    try { await options.onAuthorizationFailure?.() } catch (error) { cleanupError ??= error }
    if (!current(authGeneration, active)()) return
    if (connection === active) active.key = ''
    try { if (connection === active) await options.apply(undefined, active, current(authGeneration, active)) } catch (error) { cleanupError ??= error }
    if (!current(authGeneration, active)()) return
    if (cleanupError !== undefined) { await recoveryFailure('authorization-cleanup-failed', cleanupError, active); return }
    if (current(authGeneration, active)()) state = { status: 'reauth-required', error: code }
  }
  const sync = async () => {
    if (!connection || state.status === 'reauth-required' || state.status === 'recovery-required' || requestGeneration === generation) return
    const active = connection; const activeGeneration = generation; const abort = new AbortController(); requestGeneration = activeGeneration; requestAbort = abort; clearError(); state = { ...state, status: 'syncing' }
    const previous = snapshot
    try {
      const result = await options.client.fetchConfig({ origin: active.origin, key: active.key, ...(previous ? { etag: previous.etag } : {}), hasSnapshot: previous !== undefined, signal: abort.signal })
      if (!current(activeGeneration, active)()) return
      if (result.kind === 'not-modified') {
        if (!previous) throw new P7ClientError('invalid-response')
        failures = 0; state = { status: 'ready', revision: previous.config.revision, lastSuccessAt: previous.appliedAt }
      } else {
        await options.apply(result.config, active, current(activeGeneration, active)); if (!current(activeGeneration, active)()) return
        const candidate: P7Snapshot = { config: result.config, etag: result.etag, appliedAt: now() }
        try { await options.store.save(candidate) } catch {
          if (current(activeGeneration, active)()) {
            try { await options.apply(previous?.config, active, current(activeGeneration, active)) } catch (rollbackError) { await recoveryFailure('rollback-failed', rollbackError, active); return }
          }
          throw new P7ClientError('network')
        }
        if (!current(activeGeneration, active)()) return
        snapshot = candidate; failures = 0; state = { status: 'ready', revision: candidate.config.revision, lastSuccessAt: candidate.appliedAt }
      }
      schedule(normalDelay)
    } catch (error) {
      if (!current(activeGeneration, active)()) return
      const code = error instanceof P7ClientError ? error.code : 'network'
      if (code === 'unauthorized' || code === 'forbidden') await authFailure(code, active)
      else { failures++; state = errorState(code === 'timeout' || code === 'network' || code === 'http' || code === 'invalid-response' ? code : 'network'); schedule(retryDelay(failures - 1)) }
    } finally { if (requestGeneration === activeGeneration) { requestGeneration = undefined; requestAbort = undefined } }
  }
  const switchConnection = async (next: ManagedConnection, restore: boolean) => {
    const expected = ++generation; cancelRequest(); clearSchedule(); connection = next
    if (!restore) { snapshot = undefined; try { await options.store.clear() } catch { /* server sync may restore availability */ } }
    if (!current(expected, next)()) return
    try { await options.apply(restore ? snapshot?.config : undefined, next, current(expected, next)) } catch { if (current(expected, next)()) state = errorState('network'); return }
    if (!current(expected, next)()) return
    state = snapshot && restore ? { status: 'stale', revision: snapshot.config.revision, lastSuccessAt: snapshot.appliedAt } : { status: 'idle' }; await sync()
  }
  return {
    connect: next => switchConnection(next, false), restore: next => switchConnection(next, true),
    async disconnect() { const expected = ++generation; cancelRequest(); clearSchedule(); const previous = connection; connection = undefined; snapshot = undefined; let cleanupError: unknown; try { await options.store.clear() } catch (error) { cleanupError = error }; if (generation !== expected || connection !== undefined) return; if (previous) try { await options.apply(undefined, previous, current(expected, undefined)) } catch (error) { cleanupError ??= error }; if (generation !== expected || connection !== undefined) return; if (cleanupError !== undefined && previous) { try { await options.onRecoveryFailure?.({ reason: 'disconnect-cleanup-failed', error: cleanupError, connection: previous }) } catch { /* final local state must still fail closed */ }; if (generation === expected && connection === undefined) state = { status: 'recovery-required', error: 'recovery-required' }; return }; if (generation === expected && connection === undefined) state = { status: 'idle' } },
    start() { started = true; if (state.status === 'ready') schedule(normalDelay); else void sync() }, stop() { started = false; generation++; cancelRequest(); clearSchedule() }, sync, getState: () => ({ ...state }),
  }
}
