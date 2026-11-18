import { createHash } from 'node:crypto'
import type { MnemonLegacySpaceReader } from './mnemon-bridge.js'
import type { PersonalMemoryItem } from './personal-memory.js'
import type { PersonalMemoryRemote, PersonalMemorySyncIdentity, PersonalMemorySyncStore } from './personal-memory-sync.js'

type LegacyTracked = { content: string; revision: number; kind: 'space'; snapshot: string; tombstone?: true }
export interface LegacySpaceSyncResult { state: 'synced' | 'partial' | 'offline' | 'cancelled'; uploaded: number; conflicts: string[] }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const keyFor = (identity: PersonalMemorySyncIdentity) => `${identity.organizationId}:${identity.userId}:${identity.workspaceKey}:legacy-native-spaces`
const fingerprint = (item: Pick<PersonalMemoryItem, 'title' | 'content' | 'attributes'>) => JSON.stringify({ title: item.title, content: item.content, attributes: item.attributes ?? {} })

/**
 * One-way legacy Native import. It never mutates Mnemon, and a partial source
 * read returns before touching P7 so absent local data can never delete cloud data.
 */
export async function syncLegacySpaces(remote: PersonalMemoryRemote, bridge: MnemonLegacySpaceReader, store: PersonalMemorySyncStore, identity: PersonalMemorySyncIdentity, signal?: AbortSignal): Promise<LegacySpaceSyncResult> {
  try {
    const status = await remote.status(signal)
    if (!status.syncEnabled) return { state: 'partial', uploaded: 0, conflicts: [] }
    const spaces = await bridge.readLegacySpaces(signal)
    if (spaces.some(space => space.unavailable)) return { state: 'partial', uploaded: 0, conflicts: [] }
    const entries = spaces.flatMap(space => space.insights.map(insight => ({
      id: `mnemon:legacy-native:${digest(`${identity.workspaceKey}\u0000${space.body.id}\u0000${insight.id}`)}`,
      kind: 'space' as const, workspaceKey: identity.workspaceKey, title: insight.category ?? space.body.name, content: insight.content,
      sourceId: `mnemon-native:${space.body.id}:${insight.id}`,
      attributes: { legacy: true, memoryBodyId: space.body.id, memoryBodyName: space.body.name, ...(insight.category === undefined ? {} : { category: insight.category }), ...(insight.importance === undefined ? {} : { importance: insight.importance }), ...(insight.tags === undefined ? {} : { tags: insight.tags }), ...(insight.entities === undefined ? {} : { entities: insight.entities }), ...(insight.source === undefined ? {} : { source: insight.source }), ...(insight.createdAt === undefined ? {} : { createdAt: insight.createdAt }) },
    })))
    if (entries.length > 1000 || Buffer.byteLength(entries.map(entry => entry.content).join('')) > 10 * 1024 * 1024) return { state: 'partial', uploaded: 0, conflicts: [] }
    const tracked = { ...(store.get(keyFor(identity)) ?? {}) } as Record<string, LegacyTracked>
    const remoteItems = new Map<string, PersonalMemoryItem>(); let after = 0; let complete = false
    for (let page = 0; page < 100; page++) { const value = await remote.list(after, signal); for (const item of value.items) if (item.workspaceKey === identity.workspaceKey) { const previous = remoteItems.get(item.id); if (!previous || item.revision > previous.revision) remoteItems.set(item.id, item) }; if (!value.hasMore) { complete = true; break }; if (value.nextCursor <= after) return { state: 'partial', uploaded: 0, conflicts: [] }; after = value.nextCursor }
    if (!complete) return { state: 'partial', uploaded: 0, conflicts: [] }
    let uploaded = 0; const conflicts: string[] = []
    for (const entry of entries) try {
      const previous = tracked[entry.id]; const current = fingerprint(entry); const cloud = remoteItems.get(entry.id)
      if (previous?.tombstone || cloud?.deleted) { if (cloud?.deleted) tracked[entry.id] = { content: '', revision: cloud.revision, kind: 'space', snapshot: '', tombstone: true }; continue }
      if (!previous) { if (cloud) { if (fingerprint(cloud) === current) tracked[entry.id] = { content: cloud.content, revision: cloud.revision, kind: 'space', snapshot: current }; else conflicts.push(entry.id) } else { const saved = await remote.put({ ...entry, expectedRevision: 0 }, signal); tracked[entry.id] = { content: saved.content, revision: saved.revision, kind: 'space', snapshot: current }; uploaded++ }; continue }
      const localChanged = previous.snapshot !== current; const cloudChanged = !cloud || fingerprint(cloud) !== previous.snapshot
      if (localChanged && cloudChanged) { conflicts.push(entry.id); continue }
      if (localChanged && cloud) { const saved = await remote.put({ ...entry, expectedRevision: cloud.revision }, signal); tracked[entry.id] = { content: saved.content, revision: saved.revision, kind: 'space', snapshot: current }; uploaded++; continue }
      if (cloudChanged) conflicts.push(entry.id)
      else if (cloud) tracked[entry.id] = { ...previous, revision: cloud.revision }
    } finally { await store.set(keyFor(identity), tracked) }
    await store.set(keyFor(identity), tracked)
    return { state: 'synced', uploaded, conflicts }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { state: 'cancelled', uploaded: 0, conflicts: [] }
    return { state: 'offline', uploaded: 0, conflicts: [] }
  }
}
