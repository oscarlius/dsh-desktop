/** Live P7 company bootstrap -> Cordis web/tool-web smoke; never prints the key. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as toolWeb from '@deepseek-ai/dsh-tool-web'
import * as p7 from '../../dsh-plugin-p7-web-search/lib/index.js'
import { CompanyHost } from '../../dsh-plugin-p7-company-models/lib/index.js'

const bootstrapPath = process.env.DSH_P7_BOOTSTRAP_FILE
if (bootstrapPath === undefined) throw new Error('DSH_P7_BOOTSTRAP_FILE is required')
if ((await stat(bootstrapPath)).size > 8192) throw new Error('P7 bootstrap file is too large')
const bootstrap = JSON.parse(await readFile(bootstrapPath, 'utf8'))
if (typeof bootstrap?.origin !== 'string' || typeof bootstrap?.key !== 'string' || !/^p7k_[\x21-\x7e]+$/u.test(bootstrap.key)) throw new Error('P7 bootstrap file has no valid connection')

const profileDir = await mkdtemp(join(tmpdir(), 'dsh-p7-live-profile-'))
const ctx = new Context()
let stored = ''
let webSearchTool
let host
const settingsData = { providers: {} }
try {
  ctx.provide('credentials', { resolve: async () => stored === '' ? undefined : { value: stored, source: 'profile' } })
  ctx.provide('profileContext', { dir: profileDir })
  ctx.provide('systemPrompt', { section() {}, getSectionOrder() { return 0 } })
  ctx.provide('tools', { get() { return undefined }, register(definition) { if (definition.name === 'web_search') webSearchTool = definition } })
  await ctx.plugin(WebRuntime, { searchProvider: 'p7' })
  await ctx.plugin(p7, { origin: bootstrap.origin, requestTimeoutMs: 10_000 })
  await ctx.plugin(toolWeb, { fetch: false })
  const persistence = { value: { version: 1, origin: null, ownedIds: [] }, async load() { return this.value }, async save(value) { this.value = value } }
  host = new CompanyHost({
    profileId: profileDir, persistence,
    settings: { describe: () => [{ ns: 'models', revision: 1, value: settingsData }], async mutate(_ns, ops) { for (const op of ops) { const id = op.path[1]; if (op.op === 'set') settingsData.providers[id] = op.value; else delete settingsData.providers[id] } } },
    modelNamespace: () => 'models',
    credentials: { read: async () => stored || undefined, async set(_ref, key) { stored = key; ctx.emit('credentials/reference-updated', p7.p7CredentialRef(profileDir)) }, async unset() { stored = ''; ctx.emit('credentials/reference-updated', p7.p7CredentialRef(profileDir)) } },
    readDefault: () => ({ provider: 'local', model: 'local' }), saveDefault: async () => {}, bootstrap: async () => bootstrap,
  })
  await host.initialize()
  assert.equal(host.status().phase, 'ready')
  const direct = await ctx.web.search({ query: 'OpenAI latest news', maxResults: 3 })
  assert.ok(direct.sources.length > 0)
  const viaTool = await webSearchTool.execute({ queries: ['人工智能 最新 新闻'] }, { signal: undefined })
  assert.ok(viaTool.sources.length > 0)
  console.log(`Live P7 Host profile passed: ${direct.sources.length} direct and ${viaTool.sources.length} tool-web sources; key withheld.`)
} finally {
  await host?.dispose()
  await ctx.fiber.dispose()
  await rm(profileDir, { recursive: true, force: true })
}
