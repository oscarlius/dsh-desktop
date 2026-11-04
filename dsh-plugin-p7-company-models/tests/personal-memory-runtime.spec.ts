import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompanyMemoryCheckpoint, CompanyMemoryRuntime } from '../src/personal-memory-runtime.js'

let temporary = ''
afterEach(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }) })
describe('company memory lifetime', () => {
  it('retains baselines and prevents a different employee claiming old local notes', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'p7-memory-checkpoint-'))
    const file = join(temporary, 'state.json')
    const first = new CompanyMemoryCheckpoint(file)
    expect(await first.claim('workspace', 'org:user-a')).toBe(true)
    await first.set('org:user-a:workspace', { note: { content: 'private fixture', revision: 3, kind: 'runtime' } })
    const second = new CompanyMemoryCheckpoint(file)
    expect(second.get('org:user-a:workspace')?.note?.revision).toBe(3)
    expect(await second.claim('workspace', 'org:user-b')).toBe(false)
    expect(await second.claim('workspace', 'org:user-a')).toBe(true)
  })
  it('does not start network access when no employee is signed in', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'p7-memory-signed-out-'))
    const token = vi.fn()
    const runtime = new CompanyMemoryRuntime({ profileDirectory: temporary,
      account: { status: () => ({}), getValidAccessToken: token, subscribe: () => () => {} } as never,
      origin: () => 'http://127.0.0.1:1', authenticatedUrl: value => value, workspaces: () => [], log: () => {} })
    await runtime.sync()
    await runtime.dispose()
    expect(token).not.toHaveBeenCalled()
  })
})
