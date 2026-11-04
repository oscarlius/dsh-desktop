import type { AccountBroker, P7AccountProfile } from './account-broker.js'

export type PersonalMemoryKind = 'runtime' | 'document' | 'space'
export interface PersonalMemoryItem { id: string; revision: number; kind: PersonalMemoryKind; workspaceKey: string; title: string; content: string; sourceId: string; sessionId?: string; attributes?: Record<string, unknown>; deleted: boolean; updatedAt: string }
export interface PersonalMemoryStatus { syncEnabled: boolean; itemCount: number; sizeBytes: number; maxBytes: number; maxItems: number; userId: string; organizationId: string; rawChatCapture: false; revision?: number }
export interface PersonalMemoryPage { items: PersonalMemoryItem[]; nextCursor: number; hasMore: boolean }
export interface PersonalMemoryDream { id: string; status: 'proposed' | 'accepted' | 'rejected' | 'invalidated'; createdAt: string; sourceRevisions: unknown[]; workspaceKeys: string[]; content?: string }
export interface PersonalMemoryDreamPage { items: PersonalMemoryDream[] }
export interface PersonalMemorySpace { externalId: string; name: string; description: string; revision: number; deleted: boolean }
export interface PersonalMemorySpacePage { items: PersonalMemorySpace[] }

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** P7 owner-scoped memory API. It only ever authenticates with the current personal token. */
export class PersonalMemoryClient {
  constructor(private readonly account: Pick<AccountBroker, 'status' | 'connection' | 'getValidAccessToken'>, private readonly fetcher: Fetcher = fetch) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const profile = this.account.status().profile
    const origin = this.account.connection().origin
    if (!profile || !origin) throw new Error('P7 personal sign-in is required for company memory.')
    const sameIdentity = () => {
      const current = this.account.status().profile
      return current?.userId === profile.userId && current.organizationId === profile.organizationId && current.sessionId === profile.sessionId && this.account.connection().origin === origin
    }
    const token = await this.account.getValidAccessToken()
    if (!sameIdentity()) throw new DOMException('P7 personal identity changed.', 'AbortError')
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(20_000)])
    const response = await this.fetcher(`${origin}${path}`, { ...init, signal, redirect: 'error', headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...init.headers } })
    if (!sameIdentity()) throw new DOMException('P7 personal identity changed.', 'AbortError')
    if (!response.ok) throw new Error(`P7 personal memory request failed (${response.status})`)
    const value = await response.json() as T
    if (!sameIdentity()) throw new DOMException('P7 personal identity changed.', 'AbortError')
    this.assertOwner(value, profile)
    return value
  }

  private assertOwner(value: unknown, profile: P7AccountProfile): void {
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if ((record.userId !== undefined && record.userId !== profile.userId) || (record.organizationId !== undefined && record.organizationId !== profile.organizationId)) throw new Error('P7 personal memory identity mismatch.')
  }

  status(signal?: AbortSignal): Promise<PersonalMemoryStatus> { return this.request('/api/v1/me/memory/status', signal === undefined ? {} : { signal }) }
  preferences(syncEnabled: boolean, signal?: AbortSignal): Promise<{ syncEnabled: boolean }> { return this.request('/api/v1/me/memory/preferences', { method: 'PUT', ...(signal ? { signal } : {}), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ syncEnabled }) }) }
  list(after = 0, signal?: AbortSignal): Promise<PersonalMemoryPage> { return this.request(`/api/v1/me/memory/items?after=${after}`, signal ? { signal } : {}) }
  dreams(signal?: AbortSignal): Promise<PersonalMemoryDreamPage> { return this.request('/api/v1/me/memory/dreams', signal ? { signal } : {}) }
  reviewDream(id: string, decision: 'accept' | 'reject', workspaceKey?: string, signal?: AbortSignal): Promise<PersonalMemoryDream> {
    return this.request(`/api/v1/me/memory/dreams/${encodeURIComponent(id)}/review`, { method: 'POST', ...(signal ? { signal } : {}), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, ...(workspaceKey === undefined ? {} : { workspaceKey }) }) })
  }
  listSpaces(signal?: AbortSignal): Promise<PersonalMemorySpacePage> { return this.request('/api/v1/me/memory/spaces', signal ? { signal } : {}) }
  putSpace(externalId: string, input: { expectedRevision: number; name: string; description: string }, signal?: AbortSignal): Promise<PersonalMemorySpace> { return this.request(`/api/v1/me/memory/spaces/${encodeURIComponent(externalId)}`, { method: 'PUT', ...(signal ? { signal } : {}), headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }
  deleteSpace(externalId: string, expectedRevision: number, signal?: AbortSignal): Promise<PersonalMemorySpace> { return this.request(`/api/v1/me/memory/spaces/${encodeURIComponent(externalId)}?expectedRevision=${expectedRevision}`, { method: 'DELETE', ...(signal ? { signal } : {}) }) }
  put(item: Omit<PersonalMemoryItem, 'revision' | 'deleted' | 'updatedAt'> & { expectedRevision: number }, signal?: AbortSignal): Promise<PersonalMemoryItem> {
    const { id, expectedRevision, ...body } = item
    return this.request(`/api/v1/me/memory/items/${encodeURIComponent(id)}`, { method: 'PUT', ...(signal ? { signal } : {}), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, expectedRevision }) })
  }
  delete(id: string, expectedRevision: number, signal?: AbortSignal): Promise<PersonalMemoryItem> { return this.request(`/api/v1/me/memory/items/${encodeURIComponent(id)}?expectedRevision=${expectedRevision}`, { method: 'DELETE', ...(signal ? { signal } : {}) }) }
}
