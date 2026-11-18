import { describe, expect, it, vi } from 'vitest'
import { PersonalMemoryClient } from '../src/personal-memory.js'

const profile = { userId: 'user', organizationId: 'org', displayName: 'User', role: 'employee', deviceId: 'device', sessionId: 'session', scopes: [] }
function account(overrides: object = {}) { return { status: () => ({ profile }), connection: () => ({ origin: 'https://p7.example', getValidAccessToken: async () => 'token', usesPersonalToken: () => true }), getValidAccessToken: async () => 'token', ...overrides } }

describe('PersonalMemoryClient', () => {
  it('uses only the current personal bearer token and preserves owner isolation', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ syncEnabled: true, itemCount: 0, sizeBytes: 0, maxBytes: 1, maxItems: 1, userId: 'user', organizationId: 'org', rawChatCapture: false }), { status: 200 }))
    await expect(new PersonalMemoryClient(account() as never, fetcher).status()).resolves.toMatchObject({ syncEnabled: true })
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer token' })
  })
  it('rejects an owner mismatch instead of accepting another employee memory', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ userId: 'other', organizationId: 'org' }), { status: 200 }))
    await expect(new PersonalMemoryClient(account() as never, fetcher).status()).rejects.toThrow('identity mismatch')
  })
  it('aborts before sending a personal token when the signed-in account changes during token retrieval', async () => {
    let current = profile
    let release!: (token: string) => void
    const token = new Promise<string>(resolve => { release = resolve })
    const fetcher = vi.fn()
    const broker = account({ status: () => ({ profile: current }), getValidAccessToken: async () => await token })
    const pending = new PersonalMemoryClient(broker as never, fetcher).status()
    current = { ...profile, userId: 'other', sessionId: 'other-session' }
    release('old-token')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('reads and reviews dreams with the current owner session', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(input).endsWith('/dreams') ? { items: [{ id: 'dream-1', status: 'proposed', createdAt: 'now', sourceRevisions: [], workspaceKeys: ['a'.repeat(64)], content: 'Candidate' }] } : { id: 'dream-1', status: 'accepted', createdAt: 'now', sourceRevisions: [], workspaceKeys: ['a'.repeat(64)], content: 'Candidate' }), { status: 200 }))
    const client = new PersonalMemoryClient(account() as never, fetcher)
    await expect(client.dreams()).resolves.toMatchObject({ items: [{ id: 'dream-1', status: 'proposed' }] })
    await client.reviewDream('dream-1', 'accept', 'a'.repeat(64))
    expect(String(fetcher.mock.calls[1]![0])).toContain('/dreams/dream-1/review')
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ decision: 'accept', workspaceKey: 'a'.repeat(64) }) })
  })
  it('uses owner-scoped registry endpoints for Memory Space discovery and creation', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith('/spaces') ? { items: [] } : { externalId: 'team', revision: 1, deleted: false, name: 'Team', description: '' }), { status: 200 }))
    const client = new PersonalMemoryClient(account() as never, fetcher)
    await expect(client.listSpaces()).resolves.toEqual({ items: [] })
    await client.putSpace('team', { expectedRevision: 0, name: 'Team', description: '' })
    expect(String(fetcher.mock.calls[1]![0])).toContain('/spaces/team')
  })
})
