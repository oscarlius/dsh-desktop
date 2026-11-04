import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AccountBroker } from './account-broker.js'
import { createHostMnemonBridge } from './mnemon-bridge.js'
import { PersonalMemoryClient } from './personal-memory.js'
import { PersonalMemorySyncAdapter, type PersonalMemorySyncStore } from './personal-memory-sync.js'
import { syncLegacySpaces } from './personal-memory-legacy-spaces.js'

type Entries = NonNullable<ReturnType<PersonalMemorySyncStore['get']>>
type Checkpoint = { version: 1; owners: Record<string, string>; entries: Record<string, Entries>; signatures: Record<string, string> }
export interface CompanyMemoryWorkspace { id: string; path: string }
export interface CompanyMemoryRuntimeOptions {
  profileDirectory: string
  account: AccountBroker
  origin(): string
  authenticatedUrl(origin: string): string
  workspaces(): readonly CompanyMemoryWorkspace[]
  log(code: string): void
  intervalMs?: number
}
export interface CompanyMemoryRuntimeStatus {
  phase: 'idle' | 'syncing' | 'synced' | 'offline' | 'partial' | 'conflict' | 'account-mismatch'
  lastSyncedAt: string | null
  conflictCount: number
}

/** Private, durable three-way baselines. Never a view or a replacement for Mnemon storage. */
export class CompanyMemoryCheckpoint implements PersonalMemorySyncStore {
  private state: Checkpoint = { version: 1, owners: {}, entries: {}, signatures: {} }
  private pending = Promise.resolve()
  constructor(private readonly file: string) {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) return
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid private memory checkpoint')
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || (value as Checkpoint).version !== 1) throw new Error('Invalid private memory checkpoint')
    const candidate = value as Checkpoint
    if (![candidate.owners, candidate.entries, candidate.signatures].every(item => item && typeof item === 'object' && !Array.isArray(item))) throw new Error('Invalid private memory checkpoint')
    this.state = candidate
  }
  get(key: string): Entries | undefined { return this.state.entries[key] }
  async set(key: string, value: Entries): Promise<void> { this.state.entries[key] = value; await this.persist() }
  owner(key: string): string | undefined { return this.state.owners[key] }
  async claim(key: string, owner: string): Promise<boolean> {
    if (this.owner(key) && this.owner(key) !== owner) return false
    if (!this.owner(key)) { this.state.owners[key] = owner; await this.persist() }
    return true
  }
  signature(key: string): string | undefined { return this.state.signatures[key] }
  async recordSignature(key: string, value: string): Promise<void> { this.state.signatures[key] = value; await this.persist() }
  private persist(): Promise<void> {
    const value = JSON.stringify(this.state)
    if (Buffer.byteLength(value) > 32 * 1024 * 1024) return Promise.reject(new Error('Memory checkpoint is full'))
    this.pending = this.pending.catch(() => {}).then(() => writeFileAtomic(this.file, value, { mode: 0o600, dirMode: 0o700 }))
    return this.pending
  }
}

/** One finite sync flight per Profile; user/org changes cancel it before any new call. */
export class CompanyMemoryRuntime {
  private readonly checkpoints: CompanyMemoryCheckpoint
  private readonly remote: PersonalMemoryClient
  private status: CompanyMemoryRuntimeStatus = { phase: 'idle', lastSyncedAt: null, conflictCount: 0 }
  private timer?: ReturnType<typeof setTimeout>
  private flight: Promise<void> | undefined
  private controller: AbortController | undefined
  private closed = false
  private readonly unsubscribe: () => void
  constructor(private readonly options: CompanyMemoryRuntimeOptions) {
    this.checkpoints = new CompanyMemoryCheckpoint(join(options.profileDirectory, '.p7-memory-sync-v1.json'))
    this.remote = new PersonalMemoryClient(options.account)
    this.unsubscribe = options.account.subscribe(() => {
      this.controller?.abort()
      this.status = { phase: 'idle', lastSyncedAt: null, conflictCount: 0 }
      void this.sync()
    })
  }
  snapshot(): CompanyMemoryRuntimeStatus { return { ...this.status } }
  start(): void {
    if (this.closed || this.timer) return
    const tick = (): void => {
      void this.sync()
      this.timer = setTimeout(tick, this.options.intervalMs ?? 60_000)
      this.timer.unref()
    }
    tick()
  }
  async sync(): Promise<void> {
    if (this.closed || this.flight) return this.flight
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.flight = this.syncCurrent(signal).catch(() => {
      if (!signal.aborted) { this.status.phase = 'offline'; this.options.log('memory_sync_unavailable') }
    }).finally(() => { this.flight = undefined; this.controller = undefined })
    return this.flight
  }
  private async syncCurrent(signal: AbortSignal): Promise<void> {
    const profile = this.options.account.status().profile
    if (!profile) return
    const remoteStatus = await this.remote.status(signal)
    if (!remoteStatus.syncEnabled) return
    this.status = { ...this.status, phase: 'syncing', conflictCount: 0 }
    const owner = `${this.options.account.connection().origin}:${profile.organizationId}:${profile.userId}`
    for (const workspace of this.options.workspaces().slice(0, 32)) {
      signal.throwIfAborted()
      try {
        const workspaceKey = createHash('sha256').update(process.platform === 'win32' ? workspace.path.toLowerCase() : workspace.path).digest('hex')
        // A different employee must never silently upload this machine's old notes.
        if (!await this.checkpoints.claim(workspaceKey, owner)) { this.status.phase = 'account-mismatch'; continue }
        const key = `${profile.organizationId}:${profile.userId}:${workspaceKey}`
        const bridge = createHostMnemonBridge({ origin: this.options.origin(), authenticatedUrl: value => this.options.authenticatedUrl(value),
          scope: { current: () => ({ workspaceId: workspace.id }) } })
        const identity = { organizationId: profile.organizationId, userId: profile.userId, workspaceKey }
        const legacy = await syncLegacySpaces(this.remote, bridge, this.checkpoints, identity, signal)
        if (legacy.state === 'partial') this.status.phase = 'partial'
        else if (legacy.state !== 'synced') this.status.phase = 'offline'
        this.status.conflictCount += legacy.conflicts.length
        const [runtime, documents] = await Promise.all([bridge.readRuntimeMemory(signal), bridge.listDocuments(signal)])
        const revision = (remoteStatus as typeof remoteStatus & { revision?: number }).revision
        const signature = `${revision ?? 'unknown'}:${runtime.revision}:${documents.revision}`
        if (revision !== undefined && this.checkpoints.signature(key) === signature) continue
        const adapter = new PersonalMemorySyncAdapter(this.remote, { ...bridge, readRuntimeMemory: async () => runtime, listDocuments: async () => documents }, this.checkpoints)
        const result = await adapter.sync(identity, signal)
        if (result.state !== 'synced') { this.status.phase = 'offline'; continue }
        this.status.conflictCount += result.conflicts.length
        if (!result.conflicts.length) await this.checkpoints.recordSignature(key, signature)
        this.status.lastSyncedAt = new Date().toISOString()
      } catch {
        signal.throwIfAborted()
        this.status.phase = 'offline'
        this.options.log('memory_workspace_sync_unavailable')
      }
    }
    if (this.status.phase === 'syncing') this.status.phase = this.status.conflictCount ? 'conflict' : 'synced'
  }
  async dispose(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    this.unsubscribe()
    this.controller?.abort()
    await this.flight
  }
}
