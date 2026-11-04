import { randomUUID } from 'node:crypto'
import type { MnemonDocument, MnemonMemoryBridge, MnemonRuntimeEntry } from './personal-memory-sync.js'

const READ_CHANNEL = '/dsh-mnemon-read'
const WRITE_CHANNEL = '/dsh-mnemon-write'

export interface MnemonBridgeScope {
  /** `ctx.workspaceRegistry`'s Workspace.id, never its filesystem path. */
  readonly workspaceId?: string
  readonly sessionId?: string
}

/** Supplies only scope selected by the Host's workspace/session runtime. */
export interface MnemonBridgeScopeProvider {
  current(): MnemonBridgeScope | Promise<MnemonBridgeScope>
}

export type MnemonBridgeFetch = (input: string | URL, init: RequestInit) => Promise<Response>

export interface HostMnemonBridgeOptions {
  /** A loopback listener origin, not a user- or prompt-supplied workspace path. */
  readonly origin: string
  /** `ctx.connection.authenticatedUrl(origin)` from the active Host generation. */
  readonly authenticatedUrl: (origin: string) => string
  readonly scope: MnemonBridgeScopeProvider
  /** Injectable only for Host integration and fixture tests. */
  readonly fetch?: MnemonBridgeFetch
}

export interface MnemonLegacySpace { id: string; name: string; description: string; active: boolean; provider: { id: string; typeId?: string } }
export interface MnemonLegacyInsight { id: string; content: string; category?: string; importance?: number; tags?: string[]; entities?: string[]; source?: string; createdAt?: string }
export interface MnemonLegacySpaceRead { body: MnemonLegacySpace; insights: MnemonLegacyInsight[]; unavailable: boolean }
/** Read-only public RPC surface for legacy Mnemon Native Memory Spaces. */
export interface MnemonLegacySpaceReader { readLegacySpaces(signal?: AbortSignal): Promise<MnemonLegacySpaceRead[]> }

interface RpcFailure { readonly code?: unknown; readonly message?: unknown }
interface RpcEnvelope {
  readonly type: unknown
  readonly rpcId: unknown
  readonly result: { readonly ok: boolean; readonly value?: unknown; readonly error?: RpcFailure }
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(message)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`Mnemon RPC returned invalid ${field}`)
  return value
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError(`Mnemon RPC returned invalid ${field}`)
  return value
}

function optionalBranches(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  return stringArray(value, 'runtime entry branches')
}

function runtimeEntry(value: unknown): MnemonRuntimeEntry {
  const entry = object(value, 'Mnemon RPC returned an invalid runtime entry')
  const target = text(entry.target, 'runtime entry target')
  const importance = text(entry.importance, 'runtime entry importance')
  const branches = optionalBranches(entry.branches)
  if (target !== 'memory' && target !== 'user') throw new TypeError('Mnemon RPC returned an invalid runtime entry target')
  if (importance !== 'critical' && importance !== 'normal' && importance !== 'low') throw new TypeError('Mnemon RPC returned an invalid runtime entry importance')
  return { content: text(entry.content, 'runtime entry content'), target, importance, ...(branches === undefined ? {} : { branches }) }
}

function document(value: unknown, contentRequired: boolean): MnemonDocument {
  const source = object(value, 'Mnemon RPC returned an invalid document')
  const content = source.content
  if (contentRequired && typeof content !== 'string') throw new TypeError('Mnemon RPC returned an invalid document content')
  const revision = source.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) throw new TypeError('Mnemon RPC returned an invalid document revision')
  return {
    id: text(source.id, 'document id'), title: text(source.title, 'document title'), description: text(source.description, 'document description'),
    content: typeof content === 'string' ? content : '', sourcePaths: stringArray(source.sourcePaths, 'document sourcePaths'), sessionIds: stringArray(source.sessionIds, 'document sessionIds'), revision,
  }
}

function cookieFrom(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')]
  const cookie = values.find((value): value is string => typeof value === 'string' && value.includes('='))?.split(';', 1)[0]
  if (cookie === undefined || cookie.length === 0) throw new Error('Mnemon Host authentication did not return a session cookie')
  return cookie
}

function loopbackOrigin(value: string): string {
  const origin = new URL(value)
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') throw new TypeError('Mnemon Host origin must use HTTP(S)')
  if (origin.hostname !== '127.0.0.1' && origin.hostname !== 'localhost' && origin.hostname !== '[::1]') throw new TypeError('Mnemon Host origin must be loopback')
  return origin.origin
}

/**
 * Public-RPC Mnemon adapter. It does not read Mnemon files or manufacture a Peer:
 * the existing Host handlers authorize scope, capability and writeEnabled themselves.
 */
export function createHostMnemonBridge(options: HostMnemonBridgeOptions): MnemonMemoryBridge & MnemonLegacySpaceReader {
  const origin = loopbackOrigin(options.origin)
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  let cookie: Promise<string> | undefined

  const authenticate = (signal?: AbortSignal): Promise<string> => {
    cookie ??= (async () => {
      const launch = new URL(options.authenticatedUrl(origin))
      if (launch.origin !== origin) throw new Error('Mnemon Host authentication URL changed origin')
      launch.pathname = '/connect'
      const response = await send(launch, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]) })
      if (response.status < 300 || response.status >= 400) throw new Error(`Mnemon Host authentication failed: HTTP ${response.status}`)
      return cookieFrom(response)
    })()
    return cookie
  }

  const call = async (channel: string, endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const rpcId = randomUUID()
    const scope = await options.scope.current()
    const request: Record<string, unknown> = { ...payload, ...scope }
    const response = await send(new URL(`${channel}/${endpoint}`, origin), {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', cookie: await authenticate(signal) },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: request }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
    })
    if (!response.ok) throw new Error(`Mnemon RPC transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
    const envelope = object(await response.json(), 'Mnemon RPC returned an invalid response') as unknown as RpcEnvelope
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result !== 'object' || envelope.result === null) throw new Error(`Mnemon RPC returned an invalid response envelope for ${endpoint}`)
    if (!envelope.result.ok) throw new Error(`Mnemon RPC ${endpoint} failed: ${typeof envelope.result.error?.message === 'string' ? envelope.result.error.message : 'unknown error'}`)
    return envelope.result.value
  }

  return {
    async readRuntimeMemory(signal) {
      const snapshot = object(await call(READ_CHANNEL, 'runtime-memory', {}, signal), 'Mnemon RPC returned an invalid runtime snapshot')
      return { revision: text(snapshot.revision, 'runtime revision'), entries: stringArrayLike(snapshot.entries, runtimeEntry, 'runtime entries') }
    },
    mutateRuntimeMemory(request, signal) {
      const { old_text, content, ...rest } = request
      const oldText = old_text ?? (request.action === 'remove' ? content : undefined)
      return call(WRITE_CHANNEL, 'runtime-memory', {
        ...rest,
        ...(request.action === 'remove' ? {} : content === undefined ? {} : { content }),
        ...(oldText === undefined ? {} : { oldText }),
      }, signal)
    },
    async listDocuments(signal) {
      const snapshot = object(await call(READ_CHANNEL, 'documents', {}, signal), 'Mnemon RPC returned an invalid document snapshot')
      return { revision: text(snapshot.revision, 'document revision'), documents: stringArrayLike(snapshot.documents, value => {
        const normalized = document(value, false)
        const { content: _content, ...summary } = normalized
        return summary
      }, 'documents') }
    },
    async readDocument(id, signal) { return document(await call(READ_CHANNEL, 'document', { id }, signal), true) },
    async mutateDocument(request, signal) {
      const result = object(await call(WRITE_CHANNEL, 'document', request, signal), 'Mnemon RPC returned an invalid document mutation')
      return { document: document(result.document, true) }
    },
    archiveDocument(id, signal) { return call(WRITE_CHANNEL, 'document', { action: 'archive', id }, signal) },
    async readLegacySpaces(signal) {
      const directory = object(await call(READ_CHANNEL, 'body-directory', {}, signal), 'Mnemon RPC returned an invalid memory body directory')
      const bodies = stringArrayLike(directory.items, value => {
        const body = object(value, 'Mnemon RPC returned an invalid memory body')
        const provider = object(body.provider, 'Mnemon RPC returned an invalid memory provider')
        const typeId = provider.typeId === undefined ? undefined : text(provider.typeId, 'memory provider typeId')
        return { id: text(body.id, 'memory body id'), name: text(body.name, 'memory body name'), description: text(body.description, 'memory body description'), active: body.active !== false, provider: { id: text(provider.id, 'memory provider id'), ...(typeId === undefined ? {} : { typeId }) } }
      }, 'memory body directory')
      const native = bodies.filter(body => (body.provider.typeId ?? body.provider.id) === 'mnemon-native').slice(0, 33)
      if (native.length > 32) throw new Error('Mnemon legacy Memory Space limit exceeded')
      if (!native.length) return []
      let count = 0; let bytes = 0
      const read = async (body: MnemonLegacySpace): Promise<MnemonLegacySpaceRead> => {
      const listed = object(await call(READ_CHANNEL, 'list', { memoryBodyIds: [body.id], limit: 1000 }, signal), 'Mnemon RPC returned an invalid memory list')
      const total = listed.total
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > 1000) throw new Error('Mnemon legacy insight limit exceeded')
      const insights = stringArrayLike(listed.items, value => {
        const item = object(value, 'Mnemon RPC returned an invalid legacy insight')
        const optionalText = (field: string) => item[field] === undefined ? undefined : text(item[field], `legacy insight ${field}`)
        const optionalNumber = (field: string) => item[field] === undefined ? undefined : typeof item[field] === 'number' ? item[field] as number : (() => { throw new TypeError(`Mnemon RPC returned invalid legacy insight ${field}`) })()
        const category = optionalText('category'), importance = optionalNumber('importance'), source = optionalText('source'), createdAt = optionalText('createdAt')
        return { id: text(item.id, 'legacy insight id'), content: text(item.content, 'legacy insight content'), ...(category === undefined ? {} : { category }), ...(importance === undefined ? {} : { importance }), ...(item.tags === undefined ? {} : { tags: stringArray(item.tags, 'legacy insight tags') }), ...(item.entities === undefined ? {} : { entities: stringArray(item.entities, 'legacy insight entities') }), ...(source === undefined ? {} : { source }), ...(createdAt === undefined ? {} : { createdAt }) }
      }, 'legacy insights')
      count += insights.length; bytes += Buffer.byteLength(insights.map(item => item.content).join(''))
      if (count > 1000 || bytes > 10 * 1024 * 1024) throw new Error('Mnemon legacy insight limit exceeded')
      const sources = stringArrayLike(listed.sources, value => object(value, 'Mnemon RPC returned an invalid legacy source'), 'legacy sources')
      const unavailable = total === 1000 || sources.some(source => source.status !== 'ready' && source.status !== 'empty')
      return { body, insights, unavailable }
      }
      return Promise.all(native.map(read))
    },
  }
}

function stringArrayLike<T>(value: unknown, normalize: (entry: unknown) => T, field: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`Mnemon RPC returned invalid ${field}`)
  return value.map(normalize)
}
