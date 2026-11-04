import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { MEMORY_SPACE_PROVIDER_API_VERSION, defineMemorySpaceProvider, defineMemorySpaceProviderDefinition, type MemoryProviderConnection, type MemorySpaceProviderDefinition, type MemorySpaceProviderHost, type MemorySpaceProviderModule } from 'dsh-mnemon-source-memory-spaces/provider-sdk'
import type { AccountBroker } from './account-broker.js'
import type { PersonalMemoryItem, PersonalMemoryPage, PersonalMemorySpace, PersonalMemorySpacePage, PersonalMemoryStatus } from './personal-memory.js'
import { PersonalMemoryClient } from './personal-memory.js'

export const P7_PERSONAL_MEMORY_SPACE_PROVIDER_ID = 'p7-personal-memory'
export interface P7MemorySpace { id: string; externalId?: string; name: string; description: string }
export interface P7Insight { id: string; content: string; category?: string; importance?: number; tags?: string[]; entities?: string[]; source?: string; createdAt?: string; memoryBodyId?: string; memoryProviderId?: string; memoryProviderLabel?: string }
export interface P7GraphNode extends P7Insight { color: string }
export interface P7PersonalMemoryRemote { status(signal?: AbortSignal): Promise<PersonalMemoryStatus>; list(after?: number, signal?: AbortSignal): Promise<PersonalMemoryPage>; put(item: Omit<PersonalMemoryItem, 'revision' | 'deleted' | 'updatedAt'> & { expectedRevision: number }, signal?: AbortSignal): Promise<PersonalMemoryItem>; delete(id: string, expectedRevision: number, signal?: AbortSignal): Promise<PersonalMemoryItem>; listSpaces(signal?: AbortSignal): Promise<PersonalMemorySpacePage>; putSpace(externalId: string, input: { expectedRevision: number; name: string; description: string }, signal?: AbortSignal): Promise<PersonalMemorySpace> }
export interface P7MemorySpaceAdapter {
  readonly id: typeof P7_PERSONAL_MEMORY_SPACE_PROVIDER_ID
  status(body: P7MemorySpace, signal?: AbortSignal): Promise<{ healthy: boolean; error?: string }>
  discover(connection: MemoryProviderConnection, signal?: AbortSignal): Promise<Array<{ externalId: string; name: string; description: string; connection: MemoryProviderConnection }>>
  list(body: P7MemorySpace, request: { query?: string; category?: string; limit?: number }, signal?: AbortSignal): Promise<P7Insight[]>
  search(body: P7MemorySpace, request: { query: string; category?: string; limit?: number }, signal?: AbortSignal): Promise<{ results: P7Insight[]; hint: string }>
  remember(body: P7MemorySpace, request: { content: string; category?: string; importance?: number; tags?: string[]; entities?: string[]; source?: string }, signal?: AbortSignal): Promise<{ id: string }>
  get(body: P7MemorySpace, id: string, signal?: AbortSignal): Promise<P7Insight | undefined>
  forget(body: P7MemorySpace, id: string, signal?: AbortSignal): Promise<{ id: string; deleted: true }>
  graph(body: P7MemorySpace, signal?: AbortSignal): Promise<{ nodes: P7GraphNode[]; edges: []; generatedAt: string }>
}
function insight(item: PersonalMemoryItem, body: P7MemorySpace): P7Insight { const attributes = item.attributes ?? {}; return { id: item.id, content: item.content, ...(item.title ? { category: item.title } : {}), ...(typeof attributes.importance === 'number' ? { importance: attributes.importance } : {}), ...(Array.isArray(attributes.tags) && attributes.tags.every(tag => typeof tag === 'string') ? { tags: attributes.tags as string[] } : {}), ...(Array.isArray(attributes.entities) && attributes.entities.every(entity => typeof entity === 'string') ? { entities: attributes.entities as string[] } : {}), source: typeof attributes.source === 'string' ? attributes.source : item.sourceId, createdAt: item.updatedAt, memoryBodyId: body.id, memoryProviderId: P7_PERSONAL_MEMORY_SPACE_PROVIDER_ID, memoryProviderLabel: 'P7 personal memory' } }
const externalId = (body: P7MemorySpace) => body.externalId ?? body.id
const workspaceKey = (body: P7MemorySpace) => createHash('sha256').update(`space:${externalId(body)}`).digest('hex')
const sourceId = (body: P7MemorySpace) => `mnemon-space:${externalId(body).slice(0, 400)}:${createHash('sha256').update(externalId(body)).digest('hex')}`
async function all(remote: P7PersonalMemoryRemote, signal?: AbortSignal): Promise<PersonalMemoryItem[]> { const latest = new Map<string, PersonalMemoryItem>(); let after = 0; for (let pageCount = 0; pageCount < 100; pageCount++) { const page = await remote.list(after, signal); for (const item of page.items) { const previous = latest.get(item.id); if (!previous || item.revision > previous.revision) latest.set(item.id, item) }; if (latest.size > 10_000 || [...latest.values()].reduce((bytes, item) => bytes + Buffer.byteLength(item.content ?? ''), 0) > 10 * 1024 * 1024) throw new Error('P7 memory page limit exceeded.'); if (!page.hasMore) return [...latest.values()]; if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= after) throw new Error('P7 memory cursor did not advance.'); after = page.nextCursor } throw new Error('P7 memory page limit exceeded.') }

/** Exact-write Memory Spaces data-plane adapter. Host provider registration remains a separate SDK integration. */
export function createP7PersonalMemorySpaceProvider(remote: P7PersonalMemoryRemote): P7MemorySpaceAdapter {
  const items = async (body: P7MemorySpace, signal?: AbortSignal) => (await all(remote, signal)).filter(item => item.kind === 'space' && item.workspaceKey === workspaceKey(body) && !item.deleted)
  const ensureSpace = async (body: P7MemorySpace, signal?: AbortSignal) => { const key = externalId(body); const existing = (await remote.listSpaces(signal)).items.find(space => space.externalId === key); if (existing?.deleted) throw new Error('P7 personal memory space was deleted and cannot be revived.'); if (!existing) await remote.putSpace(key, { expectedRevision: 0, name: body.name, description: body.description }, signal) }
  return {
    id: P7_PERSONAL_MEMORY_SPACE_PROVIDER_ID,
    async status(_body, signal) { try { const status = await remote.status(signal); return status.syncEnabled ? { healthy: true } : { healthy: false, error: 'Personal memory sync is disabled.' } } catch { return { healthy: false, error: 'P7 personal memory is unavailable.' } } },
    async list(body, request, signal) { const query = request.query?.trim().toLocaleLowerCase(); const values = (await items(body, signal)).filter(item => (!query || item.content.toLocaleLowerCase().includes(query)) && (!request.category || item.title === request.category)); return values.slice(0, request.limit ?? values.length).map(item => insight(item, body)) },
    async search(body, request, signal) { return { results: await this.list(body, request, signal), hint: 'Keyword search over P7 personal memory; semantic graph retrieval is not available.' } },
    async discover(_connection: MemoryProviderConnection, signal) { return (await remote.listSpaces(signal)).items.filter(space => !space.deleted).map(space => ({ externalId: space.externalId, name: space.name, description: space.description, connection: _connection })) },
    async remember(body, request, signal) { await ensureSpace(body, signal); const id = `space:${randomUUID()}`; const saved = await remote.put({ id, kind: 'space', workspaceKey: workspaceKey(body), title: request.category ?? 'general', content: request.content, sourceId: sourceId(body), attributes: { ...(request.importance === undefined ? {} : { importance: request.importance }), ...(request.tags === undefined ? {} : { tags: request.tags }), ...(request.entities === undefined ? {} : { entities: request.entities }), ...(request.source === undefined ? {} : { source: request.source }) }, expectedRevision: 0 }, signal); return { id: saved.id } },
    async get(body, id, signal) { const found = (await items(body, signal)).find(item => item.id === id); return found ? insight(found, body) : undefined },
    async forget(body, id, signal) { const found = (await items(body, signal)).find(item => item.id === id); if (!found) throw new Error('P7 memory item was not found in this space.'); await remote.delete(id, found.revision, signal); return { id, deleted: true } },
    async graph(body, signal) { return { nodes: (await this.list(body, {}, signal)).map(node => ({ ...node, color: '#4f46e5' })), edges: [], generatedAt: new Date().toISOString() } },
  }
}

/** Public Memory Spaces Provider definition; it has no settings or credential fields because it uses AccountBroker's current personal session. */
export function createP7PersonalMemorySpaceProviderDefinition(account: AccountBroker | (() => AccountBroker)): MemorySpaceProviderDefinition {
  const current = () => typeof account === 'function' ? account() : account
  return defineMemorySpaceProviderDefinition({
    manifest: {
      apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION, kind: 'provider', typeId: P7_PERSONAL_MEMORY_SPACE_PROVIDER_ID,
      packageName: 'dsh-plugin-p7-company-models', version: '0.1.0', label: 'P7 personal memory', summary: 'Owner-scoped P7 company memory space.',
      origin: 'third-party', locality: 'remote', workspaceBinding: 'automatic', fields: [], secrets: [], scoreSemantics: 'none',
      capabilities: { search: true, browse: true, graph: false, entities: false, related: false, remember: true, link: false, forget: true, writeMode: 'exact', deletionMode: 'soft' },
    },
    create: () => createP7PersonalMemorySpaceProvider(new PersonalMemoryClient({
      status: () => current().status(), connection: () => current().connection(),
      getValidAccessToken: () => current().getValidAccessToken(),
    })),
  })
}
export const P7PersonalMemorySpaceProviderModule: MemorySpaceProviderModule<undefined> = defineMemorySpaceProvider({
  id: P7_PERSONAL_MEMORY_SPACE_PROVIDER_ID,
  apply(ctx, host) {
    // Source children can mount before the Desktop capability/account sibling.
    // Register the definition now and resolve that public service at operation
    // time; a signed-out/unavailable account must not break local providers.
    host.install(ctx, createP7PersonalMemorySpaceProviderDefinition(() => {
      const account = ctx.get('p7Account') as AccountBroker | undefined
      if (!account) throw new Error('P7 personal-memory provider requires the public p7Account service.')
      return account
    }))
  },
})
export default P7PersonalMemorySpaceProviderModule
/** Mount through the public parent-granted Provider host; no existing provider is replaced. */
export function registerP7MemorySpaceProvider(ctx: Context, host: MemorySpaceProviderHost): () => void {
  const account = ctx.get('p7Account') as AccountBroker | undefined
  if (!account) throw new Error('P7 personal-memory provider requires the public p7Account service.')
  return host.install(ctx, createP7PersonalMemorySpaceProviderDefinition(account))
}
