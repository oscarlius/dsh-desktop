/** Real TLS/TCP integration. Start P7's manual/dsh_loopback.py first; build this
 * workspace, then start Node with NODE_EXTRA_CA_CERTS set to ready.caPath.
 * Only the upstream model output is synthetic. No fetch or LLM adapter is mocked.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { CompanyHost } from '../../lib/company-host.js'

const [readyPath, reportPath] = process.argv.slice(2)
assert(readyPath && reportPath, 'Usage: node p7-loopback.mjs ready.json report.json')
const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
assert.equal(new URL(ready.origin).hostname, '127.0.0.1')
assert.equal(new URL(ready.origin).protocol, 'https:')
assert.equal(process.env.NODE_EXTRA_CA_CERTS, ready.caPath, 'Trust only the disposable fixture CA through normal Node TLS')
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0')
const evidence = { transport: 'real HTTPS + real P7 routers + real LiteLLM + loopback synthetic upstream', checks: [], protocols: [] }
const check = name => { evidence.checks.push(name); console.log(`PASS ${name}`) }
const adminHeaders = { Authorization: `Bearer ${ready.adminToken}`, 'Content-Type': 'application/json' }
async function admin(method, path, body, status = 200) {
  const response = await fetch(ready.origin + path, { method, headers: { ...adminHeaders, 'X-Request-Id': randomUUID() }, redirect: 'error', signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  assert.equal(response.status, status, `Admin ${method} ${path}: ${text}`)
  return text ? JSON.parse(text) : null
}
let publishedRevision = 0
async function publish(models, defaultModel, enabled = true) {
  const result = await admin('PUT', ready.adminPath, { expectedRevision: publishedRevision, enabled, defaultModel, models, reason: 'Disposable P7 DSH network integration' })
  publishedRevision = result.revision
  return result
}
const ctx = new Context()
const credentials = new Map()
ctx.provide('credentials', {
  resolve: async ref => { const value = credentials.get(ref); return value === undefined ? undefined : { value } },
  listRecords: async () => [], resolveRecord: async () => undefined,
})
await ctx.plugin(LlmRuntime)
const local = { displayName: 'Local preserved', api: 'openai-completions', baseURL: ready.origin + '/v1', apiKeyEnv: 'LOCAL_UNUSED', models: [{ id: 'local-model', name: 'Local model', contextWindow: 4096, maxTokens: 1024 }] }
let providers = { local }
const adapterFiber = await ctx.plugin(PiAi, { providers })
let settingsRevision = 0
let selection = { provider: 'local', model: 'local-model' }
let saved = { version: 1, origin: null, ownedIds: [] }
const host = new CompanyHost({
  profileId: 'p7-network-integration', modelNamespace: () => 'models',
  settings: {
    describe: () => [{ ns: 'models', revision: settingsRevision, value: { providers } }],
    mutate: async (_ns, operations, expectedRevision) => {
      assert.equal(expectedRevision, settingsRevision)
      const next = { ...providers }
      for (const operation of operations) {
        assert.equal(operation.path[0], 'providers')
        if (operation.op === 'set') next[operation.path[1]] = operation.value
        else if (operation.op === 'unset') delete next[operation.path[1]]
        else assert.fail('Unexpected settings operation')
      }
      adapterFiber.update({ providers: next })
      await adapterFiber.await()
      providers = next
      settingsRevision++
    },
  },
  persistence: { load: async () => saved, save: async value => { saved = structuredClone(value) } },
  credentials: { read: async ref => credentials.get(ref), set: async (ref, value) => { credentials.set(ref, value) }, unset: async ref => { credentials.delete(ref) } },
  readDefault: () => selection, saveDefault: async (provider, model) => { selection = { provider, model } },
})
const user = text => createUserMessage({ content: [{ type: 'text', text }] })
async function stream(provider, model, messages, extra = {}) {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider, model, messages, ...extra })) assembler.push(chunk)
  assert(!['error', 'aborted'].includes(assembler.finish.kind), `Stream failed: ${JSON.stringify(assembler.finish)}`)
  return { message: assembler.message({ provider, model, ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }) }), finish: assembler.finish }
}
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')
const tools = [{ name: 'lookup_weather', description: 'Look up weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]
try {
  const unenrolled = await fetch(ready.origin + '/v1/desktop/model-config', { headers: { Authorization: `Bearer ${ready.key}` }, redirect: 'error' })
  assert.equal(unenrolled.status, 403)
  await unenrolled.arrayBuffer()
  check('unenrolled dedicated key returns 403')
  await publish(ready.models, ready.models[0].id)
  await host.initialize()
  await host.connect(ready.origin, ready.key)
  assert.equal(host.status().phase, 'ready')
  assert.equal(host.status().models.length, 3)
  assert.equal(selection.model, ready.models[0].id)
  check('real admin publication reaches CompanyHost and live LLM registry')
  const etagResponse = await fetch(ready.origin + '/v1/desktop/model-config', { headers: { Authorization: `Bearer ${ready.key}` }, redirect: 'error' })
  const etag = etagResponse.headers.get('etag')
  await etagResponse.arrayBuffer()
  const unchanged = await fetch(ready.origin + '/v1/desktop/model-config', { headers: { Authorization: `Bearer ${ready.key}`, 'If-None-Match': etag }, redirect: 'error' })
  assert.equal(unchanged.status, 304)
  await host.sync()
  check('authenticated ETag 304 preserves registered models')
  const ids = { 'openai-completions': 'p7-company-chat', 'openai-responses': 'p7-company-responses', 'anthropic-messages': 'p7-company-messages' }
  for (const model of ready.models) {
    const provider = ids[model.api]
    assert((await ctx.llm.listModels(provider)).some(item => item.id === model.id))
    const plain = await stream(provider, model.id, [user('Say integration-ok')])
    assert.match(textOf(plain.message), /integration-ok/)
    const question = user('Use lookup_weather to find the weather in Shanghai')
    const first = await stream(provider, model.id, [question], { tools })
    const call = first.message.content.find(block => block.type === 'tool-call')
    assert(call, `No tool call for ${model.api}: ${JSON.stringify(first)}`)
    assert.equal(call.name, 'lookup_weather')
    assert.equal(JSON.parse(call.arguments).city, 'Shanghai')
    const result = createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'Shanghai is sunny' }], isError: false })
    const second = await stream(provider, model.id, [question, first.message, result], { tools })
    assert.match(textOf(second.message), /integration-ok/)
    const cancelled = new BlockAssembler()
    const started = Date.now()
    for await (const chunk of ctx.llm.stream({ provider, model: model.id, messages: [user('[slow] Say integration-ok')], signal: AbortSignal.timeout(100) })) cancelled.push(chunk)
    assert.equal(cancelled.finish.kind, 'aborted')
    assert(Date.now() - started < 1500, 'Cancellation should settle before slow upstream finishes')
    evidence.protocols.push({ api: model.api, model: model.id, text: true, toolCall: true, toolResult: true, cancellation: true })
    check(`${model.api}: SSE text, tool call, tool-result round trip`)
  }
  await publish(ready.models, ready.models[1].id)
  await host.sync()
  assert.equal(selection.model, ready.models[1].id)
  assert.deepEqual(providers.local, local)
  check('admin changes default without modifying local provider')
  await publish([], null, false)
  await host.sync()
  assert.deepEqual(Object.keys(providers), ['local'])
  assert(!ctx.llm.listProviders().some(item => item.id?.startsWith('p7-company-')))
  assert.equal(host.status().models.length, 0)
  check('admin disable withdraws all managed routes from actual registry')
  await publish(ready.models, ready.models[0].id)
  await host.sync()
  if (ready.revokePath) {
    await admin(ready.revokeMethod ?? 'POST', ready.revokePath, ready.revokeBody ?? { reason: 'Disposable integration revoke' })
    await host.sync()
    assert.equal(host.status().phase, 'unauthorized')
    assert.equal(credentials.size, 0)
    assert.deepEqual(Object.keys(providers), ['local'])
    check('actual key revocation clears managed routes and stored key')
  }
  const metrics = await fetch(ready.origin + '/__fixture/metrics', { redirect: 'error' }).then(response => response.json())
  evidence.upstream = metrics
  assert.equal(metrics.toolResults, 3)
  evidence.passed = true
  writeFileSync(reportPath, JSON.stringify(evidence, null, 2) + '\n')
} catch (error) {
  evidence.passed = false
  evidence.error = String(error)
  writeFileSync(reportPath, JSON.stringify(evidence, null, 2) + '\n')
  throw error
} finally {
  await host.dispose()
  await ctx.fiber.dispose()
}
