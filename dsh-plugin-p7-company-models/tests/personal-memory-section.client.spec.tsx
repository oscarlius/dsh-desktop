// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersonalMemorySection } from '../src/client/PersonalMemorySection.js'
import { en, type CompanySettingsLocaleKey } from '../src/client/locales.js'

const t = ((key: CompanySettingsLocaleKey) => en[key]) as unknown as import('@deepseek-ai/dsh-client-ui-slots').TranslateNS<'p7-company-models'>
const status = { syncEnabled: true, itemCount: 1, sizeBytes: 10, maxBytes: 100, maxItems: 10, userId: 'u', organizationId: 'o', rawChatCapture: false as const }
const item = { id: 'm1', revision: 1, kind: 'document' as const, workspaceKey: 'project:abc', title: 'Existing', content: 'Remember this', sourceId: 'manual:m1', attributes: { description: 'keep this' }, deleted: false, updatedAt: 'now' }
afterEach(() => cleanup())
describe('PersonalMemorySection', () => {
  it('lists, creates and preserves server workspace/source identifiers on edit', async () => {
    const api = { status: vi.fn(async () => status), list: vi.fn(async () => ({ items: [item], nextCursor: 0, hasMore: false })), dreams: vi.fn(async () => ({ items: [] })), reviewDream: vi.fn(), preferences: vi.fn(async () => ({ syncEnabled: true })), put: vi.fn(async input => ({ ...item, ...input, revision: 2 })), delete: vi.fn(async () => item) }
    render(<PersonalMemorySection t={t} api={api} identityKey="u" />)
    expect(await screen.findByText('Existing')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' })); fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Updated' } }); fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(expect.objectContaining({ workspaceKey: 'project:abc', sourceId: 'manual:m1', attributes: { description: 'keep this' }, expectedRevision: 1, content: 'Updated' })))
  })
  it('shows unavailable rather than fabricated data and aborts on identity change', async () => {
    const signals: AbortSignal[] = []
    const api = { status: vi.fn((nextSignal?: AbortSignal) => new Promise<never>((_resolve, reject) => { if (nextSignal) signals.push(nextSignal); nextSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))) })), list: vi.fn(async () => ({ items: [], nextCursor: 0, hasMore: false })), dreams: vi.fn(async () => ({ items: [] })), reviewDream: vi.fn(), preferences: vi.fn(), put: vi.fn(), delete: vi.fn() }
    const view = render(<PersonalMemorySection t={t} api={api} identityKey="u1" />)
    await waitFor(() => expect(signals.length).toBe(1)); view.rerender(<PersonalMemorySection t={t} api={api} identityKey="u2" />)
    expect(signals[0]?.aborted).toBe(true)
  })
  it('shows proposed summaries and reviews them without overwriting original notes', async () => {
    const workspaceKey = 'a'.repeat(64)
    const dream = { id: 'dream-1', status: 'proposed' as const, createdAt: 'now', sourceRevisions: [], workspaceKeys: [workspaceKey], content: 'Keep the rollout rollback plan.' }
    const api = { status: vi.fn(async () => status), list: vi.fn(async () => ({ items: [], nextCursor: 0, hasMore: false })), dreams: vi.fn(async () => ({ items: [dream] })), reviewDream: vi.fn(async () => ({ ...dream, status: 'accepted' as const })), preferences: vi.fn(), put: vi.fn(), delete: vi.fn() }
    render(<PersonalMemorySection t={t} api={api} identityKey="u" />)
    expect(await screen.findByText(dream.content)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(api.reviewDream).toHaveBeenCalledWith('dream-1', 'accept', workspaceKey))
    expect(screen.getByText('Accepting creates a new memory and never overwrites the original notes.')).toBeTruthy()
  })
  it('deduplicates paged changes by newest revision and shows the translated local phase', async () => {
    const newer = { ...item, revision: 2, title: 'Newer' }; const second = { ...item, id: 'm2', title: 'Second' }
    const api = { status: vi.fn(async () => ({ ...status, localSync: { phase: 'partial' as const, lastSyncedAt: null, conflictCount: 0 } })), list: vi.fn(async (after = 0) => after === 0 ? ({ items: [item, newer], nextCursor: 2, hasMore: true }) : ({ items: [second, { ...second, deleted: true, revision: 2 }], nextCursor: 0, hasMore: false })), dreams: vi.fn(async () => ({ items: [] })), reviewDream: vi.fn(), preferences: vi.fn(), put: vi.fn(), delete: vi.fn() }
    render(<PersonalMemorySection t={t} api={api} identityKey="u" />)
    expect(await screen.findByText('Newer')).toBeTruthy(); expect(screen.queryByText('Existing')).toBeNull(); expect(screen.queryByText('Second')).toBeNull(); expect(screen.getAllByText((_content, node) => node?.textContent?.includes('Some memories still need synchronization') ?? false).length).toBeGreaterThan(0)
  })
  it('clears an unsaved form on an owner change', async () => {
    const api = { status: vi.fn(async () => status), list: vi.fn(async () => ({ items: [], nextCursor: 0, hasMore: false })), dreams: vi.fn(async () => ({ items: [] })), reviewDream: vi.fn(), preferences: vi.fn(), put: vi.fn(), delete: vi.fn() }
    const view = render(<PersonalMemorySection t={t} api={api} identityKey="org:u1:s1" />)
    await screen.findByText('No personal memories yet.'); fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'private draft' } }); view.rerender(<PersonalMemorySection t={t} api={api} identityKey="org:u2:s2" />)
    await waitFor(() => expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(''))
  })
})
