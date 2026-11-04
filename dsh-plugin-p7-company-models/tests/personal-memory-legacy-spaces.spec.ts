import { expect, it, vi } from 'vitest'
import { InMemoryPersonalMemorySyncStore, type PersonalMemoryRemote } from '../src/personal-memory-sync.js'
import { syncLegacySpaces } from '../src/personal-memory-legacy-spaces.js'

const identity = { organizationId: 'o', userId: 'u', workspaceKey: 'w' }
const source = (content = 'native fact', unavailable = false) => ({ readLegacySpaces: vi.fn(async () => [{ body: { id: 'native-1', name: 'Native', description: '', active: false, provider: { id: 'mnemon-native' } }, insights: [{ id: 'i-1', memoryBodyId: 'native-1', content }], unavailable }]) })
function remote(items: any[] = []): PersonalMemoryRemote { return { status: vi.fn(async () => ({ syncEnabled: true, itemCount: 0, sizeBytes: 0, maxBytes: 1, maxItems: 1, userId: 'u', organizationId: 'o', rawChatCapture: false as const })), list: vi.fn(async () => ({ items, nextCursor: 0, hasMore: false })), put: vi.fn(async value => ({ ...value, revision: 1, deleted: false, updatedAt: 'now' })), delete: vi.fn() } }

it('imports only explicitly Native bodies idempotently and updates a local Native edit', async () => {
  const store = new InMemoryPersonalMemorySyncStore(); const p7 = remote(); const first = source()
  await expect(syncLegacySpaces(p7, first, store, identity)).resolves.toMatchObject({ state: 'synced', uploaded: 1 })
  await expect(syncLegacySpaces(p7, source(), store, identity)).resolves.toMatchObject({ state: 'synced', uploaded: 0 })
  const saved = (p7.put as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<any>; const item = await saved
  expect((await syncLegacySpaces(remote([item]), source(), store, identity)).conflicts).toEqual([])
  const edited = remote([item]); await expect(syncLegacySpaces(edited, source('edited'), store, identity)).resolves.toMatchObject({ uploaded: 1 })
})

it('preserves cloud tombstones and does not delete on an unavailable native source', async () => {
  const store = new InMemoryPersonalMemorySyncStore(); const p7 = remote(); await syncLegacySpaces(p7, source(), store, identity)
  const item = await ((p7.put as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<any>)
  await expect(syncLegacySpaces(remote([{ ...item, deleted: true, revision: 2 }]), source(), store, identity)).resolves.toMatchObject({ uploaded: 0 })
  const unavailable = remote(); await expect(syncLegacySpaces(unavailable, source('new', true), store, identity)).resolves.toMatchObject({ state: 'partial', uploaded: 0 }); expect(unavailable.put).not.toHaveBeenCalled()
})

it('keeps a concurrent cloud and Native edit as a conflict', async () => {
  const store = new InMemoryPersonalMemorySyncStore(); const p7 = remote(); await syncLegacySpaces(p7, source(), store, identity)
  const item = await ((p7.put as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<any>)
  const changed = remote([{ ...item, content: 'cloud edit', revision: 2 }]); const result = await syncLegacySpaces(changed, source('native edit'), store, identity)
  expect(result.conflicts).toHaveLength(1); expect(changed.put).not.toHaveBeenCalled()
})

it('does not replace the three-way baseline after a cloud-only edit', async () => {
  const store = new InMemoryPersonalMemorySyncStore(); const p7 = remote(); await syncLegacySpaces(p7, source(), store, identity)
  const item = await ((p7.put as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<any>)
  const cloud = remote([{ ...item, content: 'cloud edit', revision: 2 }]); expect((await syncLegacySpaces(cloud, source(), store, identity)).conflicts).toHaveLength(1)
  const retry = remote([{ ...item, content: 'cloud edit', revision: 2 }]); expect((await syncLegacySpaces(retry, source(), store, identity)).conflicts).toHaveLength(1); expect(retry.put).not.toHaveBeenCalled()
})
