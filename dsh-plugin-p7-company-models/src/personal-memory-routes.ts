import { createHash } from 'node:crypto'
import type { AccountBroker } from './account-broker.js'
import { PersonalMemoryClient, type PersonalMemoryItem } from './personal-memory.js'
import { companyRouteOriginAllowed, readCompanyRouteBody, replyCompanyRoute, type CompanyWebServer } from './routes.js'

const ROOT = '/p7-company-models/memory'
const paths = { status: `${ROOT}/status`, list: `${ROOT}/list`, dreams: `${ROOT}/dreams`, dreamReview: `${ROOT}/dream-review`, put: `${ROOT}/put`, delete: `${ROOT}/delete`, preferences: `${ROOT}/preferences` } as const
const memoryKeys = new Set(['id', 'kind', 'workspaceKey', 'projectKey', 'title', 'content', 'sourceId', 'sessionId', 'attributes', 'expectedRevision'])

function isText(value: unknown, max = 32_768): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function validKeys(value: Record<string, unknown>, allowed: Set<string>): boolean { return Object.keys(value).every(key => allowed.has(key)) }
function revision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function item(value: Record<string, unknown>): Omit<PersonalMemoryItem, 'revision' | 'deleted' | 'updatedAt'> & { expectedRevision: number } {
  if (!validKeys(value, memoryKeys) || !isText(value.id, 128) || (value.kind !== 'runtime' && value.kind !== 'document' && value.kind !== 'space') || !isText(value.title, 200) || !isText(value.content, 65_536) || !isText(value.sourceId, 512) || !revision(value.expectedRevision) || (value.sessionId !== undefined && !isText(value.sessionId, 128))) throw new Error('invalid-body')
  if (value.projectKey !== undefined && (!isText(value.projectKey, 512) || /[\\/]/.test(value.projectKey))) throw new Error('invalid-body')
  const workspaceKey = isText(value.workspaceKey, 64) && /^[a-f0-9]{64}$/.test(value.workspaceKey) ? value.workspaceKey : isText(value.projectKey, 512) ? createHash('sha256').update(value.projectKey).digest('hex') : undefined
  if (!workspaceKey) throw new Error('invalid-body')
  if (value.attributes !== undefined && (typeof value.attributes !== 'object' || value.attributes === null || Array.isArray(value.attributes))) throw new Error('invalid-body')
  return { id: value.id, kind: value.kind, workspaceKey, title: value.title, content: value.content, sourceId: value.sourceId, ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }), ...(value.attributes === undefined ? {} : { attributes: value.attributes as Record<string, unknown> }), expectedRevision: value.expectedRevision }
}

/** Browser-facing loopback adapter for owner-scoped P7 memory; it never receives a bearer token. */
export function registerPersonalMemoryRoutes(server: CompanyWebServer, account: AccountBroker, syncStatus?: () => unknown): () => void {
  const client = new PersonalMemoryClient(account)
  return Object.entries(paths).map(([action, path]) => server.register({ kind: 'exact', path, async handler(req, res) {
    const method = action === 'status' || action === 'list' || action === 'dreams' ? 'GET' : 'POST'
    if (req.method !== method) { res.setHeader('allow', method); replyCompanyRoute(res, 405, { error: 'Method not allowed.' }); return }
    if (!companyRouteOriginAllowed(req, server.getOrigin(), method === 'POST')) { replyCompanyRoute(res, 403, { error: 'Request origin is not allowed.' }); return }
    try {
      if (action === 'status') replyCompanyRoute(res, 200, { ...await client.status(), ...(syncStatus ? { localSync: syncStatus() } : {}) })
      else if (action === 'list') {
        const after = new URL(req.url ?? '', server.getOrigin()).searchParams.get('after') ?? '0'
        if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new Error('invalid-body')
        replyCompanyRoute(res, 200, await client.list(Number(after)))
      } else if (action === 'dreams') replyCompanyRoute(res, 200, await client.dreams())
      else {
        const value = await readCompanyRouteBody(req, 131_072)
        if (action === 'put') replyCompanyRoute(res, 200, await client.put(item(value)))
        else if (action === 'delete') {
          if (!validKeys(value, new Set(['id', 'expectedRevision'])) || !isText(value.id, 128) || !revision(value.expectedRevision)) throw new Error('invalid-body')
          replyCompanyRoute(res, 200, await client.delete(value.id, value.expectedRevision))
        } else if (action === 'dreamReview') {
          if (!validKeys(value, new Set(['id', 'decision', 'workspaceKey'])) || !isText(value.id, 128) || (value.decision !== 'accept' && value.decision !== 'reject') || (value.workspaceKey !== undefined && (!isText(value.workspaceKey, 64) || !/^[a-f0-9]{64}$/.test(value.workspaceKey)))) throw new Error('invalid-body')
          replyCompanyRoute(res, 200, await client.reviewDream(value.id, value.decision, value.workspaceKey))
        } else {
          if (!validKeys(value, new Set(['syncEnabled'])) || typeof value.syncEnabled !== 'boolean') throw new Error('invalid-body')
          replyCompanyRoute(res, 200, await client.preferences(value.syncEnabled))
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const status = message === 'invalid-body' ? 422 : /\(409\)/.test(message) ? 409 : 503
      replyCompanyRoute(res, status, { error: status === 422 ? 'Invalid personal-memory request.' : status === 409 ? 'Personal memory changed.' : 'Personal memory is currently unavailable.' })
    }
  }})).reverse().reduce<(() => void)>((dispose, remove) => () => { remove(); dispose() }, () => {})
}
export { paths as PERSONAL_MEMORY_ROUTE_PATHS }
