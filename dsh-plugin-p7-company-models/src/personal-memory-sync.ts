import { createHash } from 'node:crypto'
import type { PersonalMemoryItem, PersonalMemoryPage, PersonalMemoryStatus } from './personal-memory.js'

export interface MnemonRuntimeEntry { content: string; target: 'memory' | 'user'; importance: 'critical' | 'normal' | 'low'; branches?: string[] }
export interface MnemonDocument { id: string; title: string; description: string; content: string; sourcePaths: string[]; sessionIds: string[]; revision: number }
export interface MnemonMemoryBridge {
  readRuntimeMemory(signal?: AbortSignal): Promise<{ revision: string; entries: MnemonRuntimeEntry[] }>
  mutateRuntimeMemory(request: { action: 'add' | 'replace' | 'remove'; target: MnemonRuntimeEntry['target']; content?: string; old_text?: string; importance?: MnemonRuntimeEntry['importance']; branches?: string[] }, signal?: AbortSignal): Promise<unknown>
  listDocuments(signal?: AbortSignal): Promise<{ revision: string; documents: Array<Omit<MnemonDocument, 'content'>> }>
  readDocument(id: string, signal?: AbortSignal): Promise<MnemonDocument>
  mutateDocument(request: { action: 'create' | 'update'; id?: string; title?: string; description?: string; content?: string; sourcePaths?: string[]; sessionIds?: string[] }, signal?: AbortSignal): Promise<{ document: MnemonDocument }>
  archiveDocument(id: string, signal?: AbortSignal): Promise<unknown>
}
export interface PersonalMemoryRemote { status(signal?: AbortSignal): Promise<PersonalMemoryStatus>; list(after?: number, signal?: AbortSignal): Promise<PersonalMemoryPage>; put(item: Omit<PersonalMemoryItem, 'revision' | 'deleted' | 'updatedAt'> & { expectedRevision: number }, signal?: AbortSignal): Promise<PersonalMemoryItem>; delete(id: string, expectedRevision: number, signal?: AbortSignal): Promise<PersonalMemoryItem> }
export interface PersonalMemorySyncIdentity { userId: string; organizationId: string; workspaceKey: string }
export interface PersonalMemorySyncConflict { id: string; localContent: string; remoteContent: string }
export interface PersonalMemorySyncResult { state: 'synced' | 'offline' | 'disabled' | 'cancelled'; uploaded: number; downloaded: number; deleted: number; conflicts: PersonalMemorySyncConflict[]; unsupported: readonly ['memory-spaces'] }
interface Tracked { content: string; revision: number; kind: PersonalMemoryItem['kind']; snapshot?: string; runtimeTarget?: MnemonRuntimeEntry['target']; runtimeTitle?: string; localDocumentId?: string; tombstone?: true }
export interface PersonalMemorySyncStore { get(key: string): Record<string, Tracked> | undefined; set(key: string, value: Record<string, Tracked>): void | Promise<void> }
export class InMemoryPersonalMemorySyncStore implements PersonalMemorySyncStore { private readonly entries = new Map<string, Record<string, Tracked>>(); get(key: string) { return this.entries.get(key) }; set(key: string, value: Record<string, Tracked>) { this.entries.set(key, value) } }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const keyFor = (identity: PersonalMemorySyncIdentity) => `${identity.organizationId}:${identity.userId}:${identity.workspaceKey}`
const runtimeId = (entry: MnemonRuntimeEntry) => `mnemon:runtime:${digest(`${entry.target}\u0000${entry.content}`)}`
const documentId = (id: string) => `mnemon:document:${id}`
const text = (item: PersonalMemoryItem) => item.content
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value) }
const fingerprint = (item: Pick<PersonalMemoryItem, 'title' | 'content' | 'sessionId' | 'attributes'>) => stable({ title: item.title, content: item.content, sessionId: item.sessionId ?? null, attributes: item.attributes ?? {} })
const trackedFingerprint = (tracked: Tracked) => tracked.snapshot ?? stable({ title: '', content: tracked.content, sessionId: null, attributes: {} })
const runtimeAttributes = (entry: MnemonRuntimeEntry) => ({ importance: entry.importance, ...(entry.branches === undefined ? {} : { branches: entry.branches }) })
const documentAttributes = (document: MnemonDocument) => ({ ...(document.description ? { description: document.description } : {}), ...(document.sourcePaths.length ? { sourcePaths: document.sourcePaths } : {}), ...(document.sessionIds.length ? { sessionIds: document.sessionIds } : {}) })
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function strings(value: unknown): string[] | undefined { return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : undefined }
const tombstone = (value: Tracked, revision: number): Tracked => ({ content: '', revision, kind: value.kind, tombstone: true })
async function listAll(remote: PersonalMemoryRemote, signal?: AbortSignal): Promise<PersonalMemoryItem[]> {
  const newest = new Map<string, PersonalMemoryItem>(); let after = 0
  for (let pageCount = 0; pageCount < 100; pageCount++) { const page = await remote.list(after, signal); for (const item of page.items) { const previous = newest.get(item.id); if (!previous || item.revision > previous.revision) newest.set(item.id, item) }; if (newest.size > 10_000 || [...newest.values()].reduce((bytes, item) => bytes + Buffer.byteLength(item.content ?? ''), 0) > 10 * 1024 * 1024) throw new Error('P7 memory page limit exceeded.'); if (!page.hasMore) return [...newest.values()]; if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= after) throw new Error('P7 memory cursor did not advance.'); after = page.nextCursor }
  throw new Error('P7 memory page limit exceeded.')
}
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError') }

/** Host-only incremental bridge. It deliberately uses documented Mnemon page operations, never source files or engine internals. */
export class PersonalMemorySyncAdapter {
  constructor(private readonly remote: PersonalMemoryRemote, private readonly bridge: MnemonMemoryBridge, private readonly store: PersonalMemorySyncStore = new InMemoryPersonalMemorySyncStore()) {}
  async sync(identity: PersonalMemorySyncIdentity, signal?: AbortSignal): Promise<PersonalMemorySyncResult> {
    const empty = (): PersonalMemorySyncResult => ({ state: 'synced', uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], unsupported: ['memory-spaces'] })
    try {
      abort(signal); const status = await this.remote.status(signal)
      if (!status.syncEnabled) return { ...empty(), state: 'disabled' }
      const stateKey = keyFor(identity); const tracked = { ...(this.store.get(stateKey) ?? {}) }; const result = empty()
      const [runtime, documents, remoteItems] = await Promise.all([this.bridge.readRuntimeMemory(signal), this.bridge.listDocuments(signal), listAll(this.remote, signal)])
      const local = await this.readLocal(identity, tracked, runtime.entries, documents.documents, signal)
      const remoteById = new Map(remoteItems.filter(item => item.workspaceKey === identity.workspaceKey).map(item => [item.id, item]))
      const ids = new Set([...Object.keys(tracked), ...local.keys(), ...remoteById.keys()])
      for (const id of ids) { abort(signal); await this.mergeOne(id, tracked, local.get(id), remoteById.get(id), result, signal); await this.store.set(stateKey, tracked) }
      await this.store.set(stateKey, tracked); return result
    } catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return { state: 'cancelled', uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], unsupported: ['memory-spaces'] }; return { state: 'offline', uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], unsupported: ['memory-spaces'] } }
  }
  private async readLocal(identity: PersonalMemorySyncIdentity, tracked: Record<string, Tracked>, runtimeEntries: MnemonRuntimeEntry[], documentSummaries: Array<Omit<MnemonDocument, 'content'>>, signal?: AbortSignal) {
    const local = new Map<string, { item: Omit<PersonalMemoryItem, 'revision' | 'deleted' | 'updatedAt'>; documentId?: string; runtime?: MnemonRuntimeEntry }>()
    for (const entry of runtimeEntries) {
      const known = Object.entries(tracked).find(([, value]) => !value.tombstone && value.kind === 'runtime' && value.runtimeTarget === entry.target && value.content === entry.content)?.[0]
      const id = known ?? runtimeId(entry)
      local.set(id, { item: { id, kind: 'runtime', workspaceKey: identity.workspaceKey, title: tracked[id]?.runtimeTitle ?? entry.target, content: entry.content, sourceId: `runtime:${entry.target}`, attributes: runtimeAttributes(entry) }, runtime: entry })
    }
    for (const summary of documentSummaries) {
      const document = await this.bridge.readDocument(summary.id, signal)
      const known = Object.entries(tracked).find(([, value]) => !value.tombstone && value.kind === 'document' && value.localDocumentId === document.id)?.[0]
      const id = known ?? documentId(document.id)
      local.set(id, { item: { id, kind: 'document', workspaceKey: identity.workspaceKey, title: document.title, content: document.content, sourceId: `document:${document.id}`, ...(document.sessionIds[0] === undefined ? {} : { sessionId: document.sessionIds[0] }), attributes: documentAttributes(document) }, documentId: document.id })
    }
    return local
  }
  private async mergeOne(id: string, tracked: Record<string, Tracked>, local: { item: Omit<PersonalMemoryItem, 'revision' | 'deleted' | 'updatedAt'>; documentId?: string; runtime?: MnemonRuntimeEntry } | undefined, remote: PersonalMemoryItem | undefined, result: PersonalMemorySyncResult, signal?: AbortSignal): Promise<void> {
    const previous = tracked[id]; const remoteLive = remote !== undefined && !remote.deleted
    if (!previous) {
      if (remote?.deleted) { if (local) await this.removeLocal(local, signal); tracked[id] = { content: '', revision: remote.revision, kind: remote.kind, tombstone: true }; result.deleted++; return }
      if (local && !remoteLive) await this.upload(local, undefined, tracked, result, signal)
      else if (!local && remoteLive) await this.download(id, remote!, tracked, result, signal)
      else if (local && remoteLive && fingerprint(local.item) === fingerprint(remote!)) tracked[id] = { content: remote!.content, snapshot: fingerprint(remote!), revision: remote!.revision, kind: remote!.kind, ...(local.documentId === undefined ? {} : { localDocumentId: local.documentId }), ...(local.runtime === undefined ? {} : { runtimeTarget: local.runtime.target }) }
      else if (local && remoteLive) result.conflicts.push({ id, localContent: local.item.content, remoteContent: remote!.content })
      return
    }
    if (previous.tombstone) { if (remoteLive) { await this.remote.delete(id, remote!.revision, signal); result.deleted++ }; return }
    const localChanged = local === undefined || fingerprint(local.item) !== trackedFingerprint(previous)
    const remoteChanged = !remoteLive || fingerprint(remote!) !== trackedFingerprint(previous)
    if (!localChanged && !remoteChanged) { tracked[id] = { ...previous, revision: remote!.revision }; return }
    if (localChanged && remoteChanged) {
      if (local === undefined && !remoteLive) { tracked[id] = tombstone(previous, remote?.revision ?? previous.revision); return }
      result.conflicts.push({ id, localContent: local?.item.content ?? '[deleted]', remoteContent: remoteLive ? remote!.content : '[deleted]' }); return
    }
    if (localChanged) {
      if (local === undefined) { await this.remote.delete(id, remote!.revision, signal); tracked[id] = tombstone(previous, remote!.revision); result.deleted++; return }
      await this.upload(local, remote, tracked, result, signal); return
    }
    if (!remoteLive) { if (local) await this.removeLocal(local, signal); tracked[id] = tombstone(previous, remote?.revision ?? previous.revision); result.deleted++; return }
    await this.applyRemote(id, remote!, previous, tracked, result, signal)
  }
  private async upload(local: { item: Omit<PersonalMemoryItem, 'revision' | 'deleted' | 'updatedAt'>; documentId?: string; runtime?: MnemonRuntimeEntry }, remote: PersonalMemoryItem | undefined, tracked: Record<string, Tracked>, result: PersonalMemorySyncResult, signal?: AbortSignal) {
    const saved = await this.remote.put({ ...local.item, expectedRevision: remote?.revision ?? 0 }, signal)
    tracked[saved.id] = { content: saved.content, snapshot: saved.attributes === undefined ? fingerprint(local.item) : fingerprint(saved), revision: saved.revision, kind: saved.kind, ...(local.documentId === undefined ? {} : { localDocumentId: local.documentId }), ...(local.runtime === undefined ? {} : { runtimeTarget: local.runtime.target }) }; result.uploaded++
  }
  private async download(id: string, remote: PersonalMemoryItem, tracked: Record<string, Tracked>, result: PersonalMemorySyncResult, signal?: AbortSignal) {
    if (remote.kind === 'runtime') { const target = remote.title === 'user' ? 'user' : 'memory'; const attributes = object(remote.attributes); const branches = strings(attributes.branches); await this.bridge.mutateRuntimeMemory({ action: 'add', target, content: text(remote), importance: attributes.importance === 'critical' || attributes.importance === 'low' ? attributes.importance : 'normal', ...(branches === undefined ? {} : { branches }) }, signal); tracked[id] = { content: text(remote), snapshot: fingerprint(remote), revision: remote.revision, kind: remote.kind, runtimeTarget: target, runtimeTitle: remote.title }; result.downloaded++ }
    else if (remote.kind === 'document') { const attributes = object(remote.attributes); const sourcePaths = strings(attributes.sourcePaths); const sessionIds = strings(attributes.sessionIds); const document = await this.bridge.mutateDocument({ action: 'create', title: remote.title, description: typeof attributes.description === 'string' ? attributes.description : '', content: text(remote), ...(sourcePaths === undefined ? {} : { sourcePaths }), ...(sessionIds === undefined ? {} : { sessionIds }) }, signal); tracked[id] = { content: text(remote), snapshot: fingerprint(remote), revision: remote.revision, kind: remote.kind, localDocumentId: document.document.id }; result.downloaded++ }
  }
  private async removeLocal(local: { item: Omit<PersonalMemoryItem, 'revision' | 'deleted' | 'updatedAt'>; documentId?: string; runtime?: MnemonRuntimeEntry }, signal?: AbortSignal) {
    if (local.runtime) await this.bridge.mutateRuntimeMemory({ action: 'remove', target: local.runtime.target, old_text: local.runtime.content }, signal)
    else if (local.documentId) await this.bridge.archiveDocument(local.documentId, signal)
  }
  private async applyRemote(id: string, remote: PersonalMemoryItem, previous: Tracked, tracked: Record<string, Tracked>, result: PersonalMemorySyncResult, signal?: AbortSignal) {
    if (remote.kind === 'runtime') { const attributes = object(remote.attributes); const branches = strings(attributes.branches); await this.bridge.mutateRuntimeMemory({ action: 'replace', target: previous.runtimeTarget ?? 'memory', old_text: previous.content, content: text(remote), importance: attributes.importance === 'critical' || attributes.importance === 'low' ? attributes.importance : 'normal', ...(branches === undefined ? {} : { branches }) }, signal) }
    else if (remote.kind === 'document' && previous.localDocumentId) { const attributes = object(remote.attributes); const sourcePaths = strings(attributes.sourcePaths); const sessionIds = strings(attributes.sessionIds); await this.bridge.mutateDocument({ action: 'update', id: previous.localDocumentId, title: remote.title, description: typeof attributes.description === 'string' ? attributes.description : '', content: text(remote), ...(sourcePaths === undefined ? {} : { sourcePaths }), ...(sessionIds === undefined ? {} : { sessionIds }) }, signal) }
    else return
    tracked[id] = { ...previous, content: text(remote), snapshot: fingerprint(remote), revision: remote.revision, ...(remote.kind === 'runtime' ? { runtimeTitle: remote.title } : {}) }; result.downloaded++
  }
}
