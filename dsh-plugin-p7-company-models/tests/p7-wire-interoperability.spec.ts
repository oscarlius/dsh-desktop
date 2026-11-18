import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CompanyHost } from '../src/company-host.js'
import { createP7Client, type P7Fetch } from '../src/p7-client.js'
import { validateModelConfig } from '../src/validate-config.js'
import type { PersistedCompanyState } from '../src/persistence.js'
import type { SettingsPort } from '../src/managed-provider-store.js'

interface WireStep { name: string; status: number; headers: Record<string, string>; body: unknown }
// Captured from the real P7 control/gateway routers with an isolated SQLite
// database and synthetic test credentials. No company service is contacted.
const trace: { source: string; steps: WireStep[] } = JSON.parse(readFileSync(new URL('./fixtures/p7-wire-responses.json', import.meta.url), 'utf8'))
const step = (name: string): WireStep => {
  const item = trace.steps.find(item => item.name === name)
  if (!item) throw new Error(`Missing P7 wire scenario: ${name}`)
  return item
}
const response = (item: WireStep) => new Response(item.body === null ? null : JSON.stringify(item.body), { status: item.status, headers: item.headers })

describe('P7 server wire responses consumed by DSH', () => {
  it('accepts real server catalogs/ETags and classifies unenrolled and revoked keys', async () => {
    for (const name of ['enabled', 'updated', 'disabled']) {
      const item = step(name)
      const client = createP7Client({ fetch: async () => response(item) })
      const actual = await client.fetchConfig({ origin: 'https://p7.example.invalid', key: 'p7k_synthetic-wire-key', hasSnapshot: false })
      const config = validateModelConfig(item.body)
      expect(actual).toEqual({ kind: 'snapshot', config, etag: `"${config.revision}"` })
    }
    const client = createP7Client({ fetch: async () => response(step('not-modified')) })
    await expect(client.fetchConfig({ origin: 'https://p7.example.invalid', key: 'p7k_synthetic-wire-key', hasSnapshot: true, etag: new Headers(step('enabled').headers).get('ETag')! })).resolves.toEqual({ kind: 'not-modified' })
    for (const [name, code] of [['unenrolled', 'forbidden'], ['revoked', 'unauthorized']]) {
      await expect(createP7Client({ fetch: async () => response(step(name!)) }).fetchConfig({ origin: 'https://p7.example.invalid', key: 'p7k_synthetic-wire-key', hasSnapshot: false })).rejects.toMatchObject({ code })
    }
  })

  it('applies publication, 304, changed default, disable and revocation without touching local providers', async () => {
    const queue = ['enabled', 'not-modified', 'updated', 'disabled', 'revoked'].map(step)
    const fetch: P7Fetch = async (input, init) => {
      expect(String(input)).toBe('https://p7.example.invalid/v1/desktop/model-config')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer p7k_synthetic-wire-key')
      expect(init?.redirect).toBe('error')
      const item = queue.shift()
      if (!item) throw new Error('Unexpected P7 request')
      if (item.name === 'not-modified') expect(new Headers(init?.headers).get('If-None-Match')).toBe(new Headers(step('enabled').headers).get('ETag'))
      return response(item)
    }
    let revision = 0
    const providers: Record<string, unknown> = { local: { apiKeyEnv: 'LOCAL_KEY' } }
    const settings: SettingsPort = {
      describe: () => [{ ns: 'models', revision, value: { providers } }],
      mutate: async (_namespace, operations, expectedRevision) => {
        expect(expectedRevision).toBe(revision)
        for (const operation of operations) {
          const id = operation.path[1]!
          if (operation.op === 'set') providers[id] = operation.value
          else if (operation.op === 'unset') delete providers[id]
        }
        revision++
      },
    }
    let saved: PersistedCompanyState = { version: 1, origin: null, ownedIds: [] }
    const credentials = new Map<string, string>()
    let selection = { provider: 'local', model: 'local-model' }
    const host = new CompanyHost({
      profileId: 'p7-wire-interop', settings, modelNamespace: () => 'models', fetch,
      persistence: { load: async () => saved, save: async next => { saved = next } },
      credentials: { read: async ref => credentials.get(ref), set: async (ref, key) => { credentials.set(ref, key) }, unset: async ref => { credentials.delete(ref) } },
      readDefault: () => selection, saveDefault: async (provider, model) => { selection = { provider, model } },
    })
    try {
      await host.initialize()
      await host.connect('https://p7.example.invalid', 'p7k_synthetic-wire-key')
      const initial = validateModelConfig(step('enabled').body)
      expect(host.status()).toMatchObject({ phase: 'ready', revision: initial.revision, defaultModel: initial.defaultModel })
      expect(host.status().models.map(item => item.id)).toEqual(initial.models.map(item => item.id))
      await host.sync()
      expect(host.status().revision).toBe(initial.revision)
      await host.sync()
      const updated = validateModelConfig(step('updated').body)
      expect(host.status()).toMatchObject({ phase: 'ready', revision: updated.revision, defaultModel: updated.defaultModel })
      expect(selection.model).toBe(updated.defaultModel)
      await host.sync()
      expect(host.status()).toMatchObject({ phase: 'ready', models: [], defaultModel: null })
      expect(Object.keys(providers)).toEqual(['local'])
      await host.sync()
      expect(host.status()).toMatchObject({ phase: 'unauthorized', models: [], revision: null })
      expect(credentials.size).toBe(0)
      expect(queue).toHaveLength(0)
      expect(providers.local).toEqual({ apiKeyEnv: 'LOCAL_KEY' })
    } finally { await host.dispose() }
  })
})
