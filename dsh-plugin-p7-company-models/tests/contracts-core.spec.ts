import { describe, expect, it } from 'vitest'
import { mapConfigToProviders, P7_PROVIDER_IDS } from '../src/map-providers.js'
import { ConfigValidationError, validateModelConfig } from '../src/validate-config.js'
import { config } from './fixtures/config.js'

describe('P7 model config contract', () => {
  it('keeps administrator aliases and display names verbatim while grouping API providers', () => {
    const valid = validateModelConfig(config({ models: [
      config().models[0],
      { id: 'strange-admin-alias', displayName: 'Any administrator name', api: 'anthropic-messages', contextWindow: 8192, maxOutputTokens: 2048, inputModalities: ['text', 'image'], streaming: true, tools: true },
      { id: 'responses-route', displayName: 'Response model', api: 'openai-responses', contextWindow: 4096, maxOutputTokens: 256, inputModalities: ['text'], streaming: true, tools: true, reasoningEfforts: { high: 'deep' } },
    ] }))
    const providers = mapConfigToProviders(valid, { origin: 'https://p7.example', credentialRef: 'p7-key' })
    expect(providers.map(provider => provider.id)).toEqual(Object.values(P7_PROVIDER_IDS))
    expect(providers).toEqual(expect.arrayContaining([expect.objectContaining({ rejectRedirects: true, transport: 'sse' })]))
    expect(Object.fromEntries(providers.map(provider => [provider.api, provider.baseURL]))).toEqual({
      'openai-completions': 'https://p7.example/v1',
      'openai-responses': 'https://p7.example/v1',
      'anthropic-messages': 'https://p7.example',
    })
    expect(providers[0]?.models[0]).toMatchObject({ id: 'admin-alias', name: 'Administrator supplied name', maxTokens: 1024 })
    expect(providers[2]?.models[0]?.input).toEqual(['text', 'image'])
  })
  it.each([
    config({ unexpected: true }),
    config({ defaultModel: 'missing' }),
    config({ models: [config().models[0], config().models[0]] }),
    config({ models: [{ ...config().models[0], api: 'google-native' }] }),
    config({ models: [{ ...config().models[0], maxOutputTokens: 4097 }] }),
    config({ models: [{ ...config().models[0], inputModalities: ['image'] }] }),
    config({ enabled: false, defaultModel: 'admin-alias', models: [] }),
  ])('rejects invalid configuration %#', invalid => expect(() => validateModelConfig(invalid)).toThrow(ConfigValidationError))
  it('maps disabled or empty configurations to no managed provider', () => {
    expect(mapConfigToProviders(validateModelConfig(config({ enabled: false, defaultModel: null, models: [] })), { origin: 'https://p7.example', credentialRef: 'ref' })).toEqual([])
  })
})
