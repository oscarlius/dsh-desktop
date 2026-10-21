/** Headless Cordis Host proof for the P7 search provider's profile lifecycle. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as toolWeb from '@deepseek-ai/dsh-tool-web'
import * as p7 from '../../dsh-plugin-p7-web-search/lib/index.js'

const profileDir = await mkdtemp(join(tmpdir(), 'dsh-p7-search-profile-'))
const firstKey = 'p7k_profile_smoke_first_not_a_secret'
const secondKey = 'p7k_profile_smoke_second_not_a_secret'
let stored = ''
let request = 0
const originalFetch = globalThis.fetch
const ctx = new Context()
let webSearchTool

try {
  globalThis.fetch = async (_url, init) => {
    request += 1
    const headers = init?.headers
    const authorization = headers instanceof Headers ? headers.get('authorization') : headers?.authorization
    assert.equal(authorization, `Bearer ${stored}`)
    return Response.json({ results: [{ url: 'https://search.example.test/result' }], truncated: false })
  }
  ctx.provide('credentials', {
    resolve: async () => stored === '' ? undefined : { value: stored, source: 'profile' },
  })
  ctx.provide('profileContext', { dir: profileDir })
  ctx.provide('systemPrompt', { section() {}, getSectionOrder() { return 0 } })
  ctx.provide('tools', {
    get() { return undefined },
    register(definition) { if (definition.name === 'web_search') webSearchTool = definition },
  })
  await ctx.plugin(WebRuntime, { searchProvider: 'p7' })
  await ctx.plugin(p7, { origin: 'https://p7-search.example.test' })
  await ctx.plugin(toolWeb, { fetch: false })

  // Mirrors CompanyHost: credentials.set commits the shared reference after
  // Loader startup, and the search plugin observes the standard event.
  stored = firstKey
  ctx.emit('credentials/reference-updated', p7.p7CredentialRef(profileDir))
  const first = await ctx.web.search({ query: 'profile startup search' })
  assert.deepEqual(first.sources, [{ url: 'https://search.example.test/result' }])

  stored = secondKey
  ctx.emit('credentials/reference-updated', p7.p7CredentialRef(profileDir))
  const toolResult = await webSearchTool.execute({ queries: ['rotated credential search'] }, { signal: undefined })
  assert.deepEqual(toolResult.sources, [{ url: 'https://search.example.test/result' }])
  assert.equal(request, 2)
  console.log('P7 search profile Host smoke passed: startup, rotation, and tool-web web_search reached ctx.web.search.')
} finally {
  globalThis.fetch = originalFetch
  await ctx.fiber.dispose()
  await rm(profileDir, { recursive: true, force: true })
}
