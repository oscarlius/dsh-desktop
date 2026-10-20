import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompanyHost } from '../src/company-host.js'
import type { SettingsPort } from '../src/managed-provider-store.js'
import type { PersistedCompanyState } from '../src/persistence.js'
import { P7_PROVIDER_IDS } from '../src/map-providers.js'
import { config } from './fixtures/config.js'

const state = () => {
  const store = { value: { version: 1 as const, origin: null, ownedIds: [] } as PersistedCompanyState, save: undefined as unknown, load: undefined as unknown }
  store.save = vi.fn(async (next: PersistedCompanyState) => { store.value = next })
  store.load = vi.fn(async () => store.value)
  return store as { value: PersistedCompanyState; save: (state: PersistedCompanyState) => Promise<void>; load: () => Promise<PersistedCompanyState> }
}
const settings = (): SettingsPort & { mutations: unknown[]; data: { providers: Record<string, unknown> } } => {
  const data: { providers: Record<string, unknown> } = { providers: { local: { local: true } } }; const mutations: unknown[] = []
  return { data, mutations, describe: () => [{ ns: 'models', revision: 1, value: data }], mutate: async (_ns, ops) => { mutations.push(ops); for (const op of ops as { op: string; path: string[]; value?: unknown }[]) { const id = op.path[1]!; if (op.op === 'set') data.providers[id] = op.value; else delete data.providers[id] } } }
}
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ETag: '"revision-1"', ...headers } })
const activeHosts = new Set<CompanyHost>()
afterEach(async () => { await Promise.all([...activeHosts].map(host => host.dispose())); activeHosts.clear() })
const createHost = (fetch: typeof globalThis.fetch, persisted = state(), port = settings()) => {
  const credentials = { read: vi.fn(async () => undefined), set: vi.fn(async () => {}), unset: vi.fn(async () => {}) }
  const saveDefault = vi.fn(async (_provider: string, _model: string, _reasoningEffort?: string) => {})
  const readDefault = vi.fn((): { provider: string; model: string; reasoningEffort?: string } => ({ provider: 'local-provider', model: 'local-model', reasoningEffort: 'high' }))
  const host = new CompanyHost({ profileId: 'profile-a', persistence: persisted, settings: port, modelNamespace: () => 'models', credentials, readDefault, saveDefault, fetch })
  activeHosts.add(host)
  return { host, persisted, port, credentials, readDefault, saveDefault }
}

describe('CompanyHost integration', () => {
  it('finishes a stale background default compensation before applying a new connection default', async () => {
    vi.useFakeTimers()
    let releasePoll!: () => void
    const pendingDefault = new Promise<void>(resolve => { releasePoll = resolve })
    const catalog = (id: string, revision: string) => config({ revision, defaultModel: id, models: [{ ...config().models[0], id }] })
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(config()))
      .mockResolvedValueOnce(response(catalog('poll-alias', 'poll-revision'), 200, { ETag: '"poll-revision"' }))
      .mockResolvedValueOnce(response(catalog('new-alias', 'new-revision'), 200, { ETag: '"new-revision"' }))
    const app = createHost(fetch)
    let selection = { provider: 'local', model: 'local-model' }
    app.readDefault.mockImplementation(() => ({ ...selection }))
    app.saveDefault.mockImplementation(async (provider, model) => {
      if (model === 'poll-alias') await pendingDefault
      selection = { provider, model }
    })
    try {
      await app.host.initialize()
      await app.host.connect('https://old.example', 'p7k_old')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(app.saveDefault).toHaveBeenCalledTimes(2)
      const connecting = app.host.connect('https://new.example', 'p7k_new')
      releasePoll()
      await connecting
      expect(selection).toEqual({ provider: P7_PROVIDER_IDS['openai-completions'], model: 'new-alias' })
      expect(app.host.status()).toMatchObject({ origin: 'https://new.example', revision: 'new-revision' })
    } finally { releasePoll(); await app.host.dispose(); vi.useRealTimers() }
  })

  it('connects, applies only company providers, selects the company default, and removes them for an empty catalog', async () => {
    const fetch = vi.fn(async () => response(config())) as unknown as typeof globalThis.fetch
    const app = createHost(fetch)
    await app.host.initialize(); await app.host.connect('https://p7.example', 'p7k_valid-key')
    expect(app.port.data.providers.local).toEqual({ local: true })
    expect(app.port.data.providers[P7_PROVIDER_IDS['openai-completions']]).toBeDefined()
    expect(app.saveDefault).toHaveBeenCalledWith(P7_PROVIDER_IDS['openai-completions'], 'admin-alias')
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response(config({ enabled: false, defaultModel: null, models: [] })))
    await app.host.sync()
    expect(app.port.data.providers[P7_PROVIDER_IDS['openai-completions']]).toBeUndefined()
  })

  it.each([401, 403])('revokes the credential and managed providers after a %i authorization response', async status => {
    const fetch = vi.fn(async () => response({ error: 'no' }, status)) as unknown as typeof globalThis.fetch
    const app = createHost(fetch)
    await app.host.initialize(); await app.host.connect('https://p7.example', 'p7k_valid-key')
    expect(app.credentials.unset).toHaveBeenCalledWith(app.host.credentialRef)
    expect(app.host.status()).toMatchObject({ phase: 'unauthorized', models: [] })
  })

  it('clears the key after a background polling authorization failure', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn().mockResolvedValueOnce(response(config())).mockResolvedValueOnce(response({ error: 'expired' }, 401)) as unknown as typeof globalThis.fetch
      const app = createHost(fetch)
      await app.host.initialize(); await app.host.connect('https://p7.example', 'p7k_valid-key')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(app.credentials.unset).toHaveBeenCalledWith(app.host.credentialRef)
      expect(app.host.status().phase).toBe('unauthorized')
    } finally { vi.useRealTimers() }
  })

  it('does not publish a revision when the profile default cannot be written', async () => {
    const fetch = vi.fn(async () => response(config())) as unknown as typeof globalThis.fetch
    const app = createHost(fetch); app.saveDefault.mockRejectedValueOnce(new Error('locked by higher priority profile'))
    await app.host.initialize(); await app.host.connect('https://p7.example', 'p7k_valid-key')
    expect(app.host.status()).toMatchObject({ phase: 'error', revision: null })
    expect(app.port.data.providers[P7_PROVIDER_IDS['openai-completions']]).toBeUndefined()
  })

  it('restores persisted models and accepts a 304 response without reapplying the catalog', async () => {
    const persisted = state(); persisted.value = { version: 1, origin: 'https://p7.example', ownedIds: [P7_PROVIDER_IDS['openai-completions']], snapshot: { config: config(), etag: '"revision-1"', appliedAt: 9 } } as never
    const fetch = vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof globalThis.fetch
    const app = createHost(fetch, persisted); (app.credentials.read as ReturnType<typeof vi.fn>).mockResolvedValue('p7k_restored')
    await app.host.initialize()
    expect(app.port.data.providers[P7_PROVIDER_IDS['openai-completions']]).toBeDefined()
    expect(app.host.status()).toMatchObject({ phase: 'ready', revision: 'revision-1' })
  })

  it('discards a late old-origin response when a newer connection wins', async () => {
    let resolveOld!: (value: Response) => void
    const old = new Promise<Response>(resolve => { resolveOld = resolve })
    const fetch = vi.fn().mockImplementationOnce(() => old).mockImplementationOnce(() => Promise.resolve(response(config({ revision: 'new-revision' }), 200, { ETag: '"new-revision"' }))) as unknown as typeof globalThis.fetch
    const app = createHost(fetch)
    await app.host.initialize()
    const first = app.host.connect('https://old.example', 'p7k_old')
    await Promise.resolve()
    const second = app.host.connect('https://new.example', 'p7k_new')
    resolveOld(response(config({ revision: 'old-revision' }), 200, { ETag: '"old-revision"' }))
    await Promise.all([first, second])
    expect(app.host.status()).toMatchObject({ origin: 'https://new.example', revision: 'new-revision' })
  })

  it('revokes the deterministic key and removes only matching reserved routes after corrupt persistence', async () => {
    const persisted = state(); persisted.load = vi.fn(async () => { throw new Error('corrupt') })
    const port = settings()
    const app = createHost(vi.fn() as unknown as typeof globalThis.fetch, persisted, port)
    const owned = P7_PROVIDER_IDS['openai-completions']
    const foreign = P7_PROVIDER_IDS['anthropic-messages']
    port.data.providers[owned] = { apiKeyEnv: app.host.credentialRef }
    port.data.providers[foreign] = { apiKeyEnv: 'P7_DSH_OTHER_API_KEY' }
    await app.host.initialize()
    expect(app.credentials.unset).toHaveBeenCalledWith(app.host.credentialRef)
    expect(port.data.providers[owned]).toBeUndefined()
    expect(port.data.providers[foreign]).toEqual({ apiKeyEnv: 'P7_DSH_OTHER_API_KEY' })
    expect(port.data.providers.local).toEqual({ local: true })
    expect(app.host.status()).toMatchObject({ phase: 'error', origin: null, revision: null })
    expect(app.host.status().message).toContain('matching managed providers were removed')
  })

  it('cleans up orphaned reserved routes when no persistence record remains', async () => {
    const port = settings()
    const app = createHost(vi.fn() as unknown as typeof globalThis.fetch, state(), port)
    const owned = P7_PROVIDER_IDS['openai-completions']
    const foreign = P7_PROVIDER_IDS['anthropic-messages']
    port.data.providers[owned] = { apiKeyEnv: app.host.credentialRef }
    port.data.providers[foreign] = { apiKeyEnv: 'P7_DSH_OTHER_API_KEY' }
    ;(app.credentials.read as ReturnType<typeof vi.fn>).mockResolvedValue('p7k_orphaned')
    await app.host.initialize()
    expect(app.credentials.unset).toHaveBeenCalledWith(app.host.credentialRef)
    expect(port.data.providers[owned]).toBeUndefined()
    expect(port.data.providers[foreign]).toEqual({ apiKeyEnv: 'P7_DSH_OTHER_API_KEY' })
    expect(port.data.providers.local).toEqual({ local: true })
    expect(app.host.status().message).toContain('Orphaned P7 settings were removed')
  })

  it('restores the previous default after an invalidated save when the newer connection cannot apply its default', async () => {
    let resolveFirst!: () => void
    const firstDefault = new Promise<void>(resolve => { resolveFirst = resolve })
    const fetch = vi.fn(async () => response(config())) as unknown as typeof globalThis.fetch
    const app = createHost(fetch)
    let selection: { provider: string; model: string; reasoningEffort?: string } = { provider: 'local-provider', model: 'local-model', reasoningEffort: 'high' }
    app.readDefault.mockImplementation(() => ({ ...selection }))
    app.saveDefault.mockImplementation(async (provider: string, model: string, reasoningEffort?: string) => {
      if (app.saveDefault.mock.calls.length === 1) return firstDefault
      if (app.saveDefault.mock.calls.length === 2) {
        selection = reasoningEffort === undefined ? { provider, model } : { provider, model, reasoningEffort }
        return
      }
      throw new Error('new default rejected')
    })
    await app.host.initialize()
    const first = app.host.connect('https://first.example', 'p7k_first')
    await vi.waitFor(() => expect(app.saveDefault).toHaveBeenCalledTimes(1))
    const second = app.host.connect('https://second.example', 'p7k_second')
    resolveFirst()
    await Promise.all([first, second])
    expect(selection).toEqual({ provider: 'local-provider', model: 'local-model', reasoningEffort: 'high' })
    expect(app.host.status()).toMatchObject({ phase: 'error', origin: 'https://second.example', revision: null })
  })
})
