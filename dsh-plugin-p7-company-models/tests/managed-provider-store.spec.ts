import { describe, expect, it } from 'vitest'
import { ManagedProviderStore, type SettingsPort } from '../src/managed-provider-store.js'
import { mapConfigToProviders, P7_PROVIDER_IDS } from '../src/map-providers.js'
import { validateModelConfig } from '../src/validate-config.js'
import { config } from './fixtures/config.js'

const namespace = 'models'
const provider = (id = P7_PROVIDER_IDS['openai-completions']) => ({
  id, api: 'openai-completions' as const, baseURL: 'https://p7.example/v1', credentialRef: 'ref',
  rejectRedirects: true as const, transport: 'sse' as const,
  models: [{ id: 'admin-alias', name: 'Administrator supplied name', contextWindow: 4096, maxTokens: 1024, input: ['text'] as ('text')[] }],
})
const createSettings = (value: unknown, revision = 7) => {
  const mutations: { ns: string; ops: readonly unknown[]; revision?: number | undefined }[] = []
  const settings: SettingsPort = {
    describe: () => [{ ns: namespace, revision, value }],
    mutate: async (ns, ops, expectedRevision) => { mutations.push({ ns, ops, revision: expectedRevision }) },
  }
  return { settings, mutations }
}

describe('ManagedProviderStore', () => {
  it('applies only P7 provider paths and preserves unrelated providers', async () => {
    const { settings, mutations } = createSettings({ providers: { local: { api: 'local' } } })
    const store = new ManagedProviderStore(settings, () => namespace)
    await store.apply([provider()])
    expect(mutations).toEqual([{ ns: namespace, revision: 7, ops: [expect.objectContaining({ op: 'set', path: ['providers', P7_PROVIDER_IDS['openai-completions']] })] }])
    expect(mutations[0]?.ops[0]).toMatchObject({ value: { rejectRedirects: true, transport: 'sse' } })
    expect(store.ownedIds()).toEqual([P7_PROVIDER_IDS['openai-completions']])
  })

  it('persists protocol-specific P7 base URLs', async () => {
    const providers = mapConfigToProviders(validateModelConfig(config({ models: [
      config().models[0],
      { id: 'responses', displayName: 'Responses', api: 'openai-responses', contextWindow: 2048, maxOutputTokens: 128, inputModalities: ['text'], streaming: true, tools: true },
      { id: 'messages', displayName: 'Messages', api: 'anthropic-messages', contextWindow: 2048, maxOutputTokens: 128, inputModalities: ['text'], streaming: true, tools: true },
    ] })), { origin: 'https://p7.example', credentialRef: 'ref' })
    const { settings, mutations } = createSettings({ providers: {} })
    await new ManagedProviderStore(settings, () => namespace).apply(providers)
    expect(mutations[0]?.ops.map(operation => (operation as { value: { baseURL: string } }).value.baseURL)).toEqual([
      'https://p7.example/v1', 'https://p7.example/v1', 'https://p7.example',
    ])
  })

  it('removes previously owned providers on an empty catalog without touching local providers', async () => {
    const id = P7_PROVIDER_IDS['openai-completions']
    const { settings, mutations } = createSettings({ providers: { local: { api: 'local' }, [id]: { stale: true } } })
    const store = new ManagedProviderStore(settings, () => namespace, [id])
    await store.apply([])
    expect(mutations[0]).toMatchObject({ ops: [{ op: 'unset', path: ['providers', id] }] })
    expect(store.ownedIds()).toEqual([])
  })

  it('does not overwrite a colliding P7 reserved name it does not own', async () => {
    const id = P7_PROVIDER_IDS['openai-completions']
    const { settings, mutations } = createSettings({ providers: { [id]: { local: true } } })
    await expect(new ManagedProviderStore(settings, () => namespace).apply([provider()])).rejects.toThrow('already in use')
    expect(mutations).toEqual([])
  })

  it('does not record ownership when the revision-protected mutation fails', async () => {
    const { settings } = createSettings({ providers: {} })
    settings.mutate = async () => { throw new Error('revision conflict') }
    const store = new ManagedProviderStore(settings, () => namespace)
    await expect(store.apply([provider()])).rejects.toThrow('revision conflict')
    expect(store.ownedIds()).toEqual([])
  })

  it('recovers only reserved routes that reference this profile credential', async () => {
    const owned = P7_PROVIDER_IDS['openai-completions']
    const foreign = P7_PROVIDER_IDS['anthropic-messages']
    const { settings, mutations } = createSettings({ providers: {
      local: { apiKeyEnv: 'P7_PROFILE_KEY' },
      [owned]: { apiKeyEnv: 'P7_PROFILE_KEY' },
      [foreign]: { apiKeyEnv: 'OTHER_PROFILE_KEY' },
    } })
    const store = new ManagedProviderStore(settings, () => namespace)
    await expect(store.recover('P7_PROFILE_KEY')).resolves.toEqual([owned])
    expect(mutations).toEqual([{ ns: namespace, revision: 7, ops: [{ op: 'unset', path: ['providers', owned] }] }])
    expect(store.ownedIds()).toEqual([])
  })
})
