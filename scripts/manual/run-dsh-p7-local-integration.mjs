import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '../../dsh-plugin-p7-mcp/node_modules/@deepseek-ai/cordis/lib/index.js'
import { createMcpToolDefinition } from '../../dsh-plugin-p7-mcp/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js'
import { P7McpClient, P7McpError } from '../../dsh-plugin-p7-mcp/lib/client.js'
import { presentMcpToolDefinition } from '../../dsh-plugin-p7-mcp/lib/presentation.js'
import * as p7Plugin from '../../dsh-plugin-p7-mcp/lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
// Run only against the tracked, disposable P7 loopback fixture. This runner
// changes fixture titles/publication/grants and restores the enabled grant.
const receiptPath = resolve(here, '../../.task-artifacts/mcp-hub-integration-20261107/dsh-p7-local-integration-receipt.json')
const origin = 'http://127.0.0.1:18761'
const clientOrigin = 'https://p7.fixture.test'
const adminToken = 'local-admin-test'
const mcpToken = 'p7k_LOCAL_MCP_DEMO_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh'
const jsonHeaders = { accept: 'application/json', authorization: `Bearer ${adminToken}` }
const nativeFetch = globalThis.fetch
const fixtureTransport = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : String(input))
  assert.equal(requestUrl.origin, clientOrigin, 'DSH client must target only the fixture logical HTTPS origin')
  assert.equal(requestUrl.pathname, '/v1/mcp', 'DSH client must target only the MCP endpoint')
  assert.equal(requestUrl.search, '', 'DSH client must not add query data')
  return await nativeFetch(new URL('/v1/mcp', origin), init)
}
const mcp = () => new P7McpClient(async () => ({ origin: clientOrigin, apiKey: mcpToken }), fixtureTransport)

async function admin(path, init = {}) {
  const response = await fetch(origin + path, { ...init, headers: { ...jsonHeaders, ...init.headers } })
  const body = await response.json()
  assert.equal(response.ok, true, `${init.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`)
  return body
}

async function grantRevision(accessKeyId, serverId) {
  const grants = await admin(`/api/v1/model-admin/access-keys/${encodeURIComponent(accessKeyId)}/mcp-grants`)
  const grant = grants.items?.find(item => item.serverId === serverId)
  return grant?.revision ?? 0
}

async function until(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function verifyCordisRegistration(echoWireName, echoedArgs) {
  const prefix = 'dsh-p7-local-integration-'
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const registered = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = fixtureTransport
  try {
    await writeFile(join(dir, '.p7-company-models.json'), JSON.stringify({ origin: clientOrigin }))
    const host = new Context()
    host.provide('profileContext', { dir })
    host.provide('credentials', { resolve: async () => undefined })
    host.provide('p7Account', { usesPersonalToken: () => true, getValidAccessToken: async () => mcpToken, subscribe: () => () => {} })
    host.provide('tools', { register: definition => { registered.push(definition); return () => {} } })
    const fiber = await host.plugin(p7Plugin)
    try {
      await until(() => registered.length === 2, 'Cordis P7 plugin did not register both fixture tools')
      const echo = registered.find(definition => definition.name === `mcp__p7__${echoWireName}`)
      assert.ok(echo, 'Cordis plugin must register the original public tool name')
      assert.deepEqual(await echo.execute(echoedArgs, { signal: new AbortController().signal }), { content: [{ type: 'text', text: 'hello' }] })
      return registered.map(definition => definition.name).sort()
    } finally {
      await fiber.dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
    const target = resolve(dir)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(prefix)) throw new Error('Unsafe integration cleanup target')
    await rm(target, { recursive: true, force: true })
  }
}

async function main() {
  const receipt = { target: origin, mode: 'headless HTTP plus DSH host', transport: 'fixed HTTPS logical origin mapped by test-only fetcher to local HTTP /v1/mcp', tlsAcceptanceTested: false, installedGuiTested: false, checks: [] }
  const catalog = await admin('/api/v1/model-admin/mcp-servers')
  const server = catalog.items?.[0]
  assert.ok(server?.id && Number.isInteger(server.revision), 'fixture server metadata is required')
  const manifest = await admin('/__demo__/manifest')
  assert.equal(manifest.serverId, server.id, 'manifest and catalog server IDs must agree')
  assert.ok(manifest.accessKeyId, 'fixture access key ID is required')
  const serverId = manifest.serverId
  const echoRawName = 'fixture_echo'
  const statusRawName = 'fixture_status'
  const echoWireName = 'demo__fixture_echo'
  const statusWireName = 'demo__fixture_status'

  const before = await mcp().list()
  assert.deepEqual(before.map(tool => tool.name).sort(), [echoWireName, statusWireName])
  assert.equal(before.every(tool => tool.server?.name && tool.server.namespace === 'demo'), true)
  receipt.checks.push('real P7McpClient initialized and listed two tools in one demo server group')

  const ctx = new Context()
  const definitions = before.map(tool => presentMcpToolDefinition(createMcpToolDefinition(ctx, {
    name: `mcp__p7__${tool.name}`, rawName: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    call: args => mcp().call(tool.name, args),
  }), tool.name, tool.title))
  const echo = definitions.find(definition => definition.name === `mcp__p7__${echoWireName}`)
  assert.ok(echo, 'echo tool definition must exist')
  const echoedArgs = { text: 'hello' }
  const echoed = await echo.execute(echoedArgs, { signal: new AbortController().signal })
  assert.deepEqual(echoed, { content: [{ type: 'text', text: 'hello' }] })
  assert.equal(echo.presentCall?.(echoedArgs).title, before.find(tool => tool.name === echoWireName)?.title)
  assert.equal(echo.presentResult?.(echoedArgs, echoed).title, before.find(tool => tool.name === echoWireName)?.title)
  receipt.checks.push('createMcpToolDefinition and presentMcpToolDefinition preserved the wire ID and arguments and made a safe fixture call')
  assert.deepEqual(await verifyCordisRegistration(echoWireName, echoedArgs), [`mcp__p7__${echoWireName}`, `mcp__p7__${statusWireName}`])
  receipt.checks.push('isolated Cordis eager P7 plugin registered both DSH definitions and invoked the registered fixture tool')

  const overridden = await admin(`/api/v1/model-admin/mcp-servers/${encodeURIComponent(serverId)}/tool-overrides`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: server.revision, reason: 'local DSH integration fixture', tools: { fixture_echo: { title: '测试知识问答' }, fixture_status: { title: '服务状态查询' } } }),
  })
  const afterOverride = await mcp().list()
  assert.equal(afterOverride.find(tool => tool.name === echoWireName)?.title, '测试知识问答')
  const overriddenDefinition = presentMcpToolDefinition(createMcpToolDefinition(ctx, {
    name: `mcp__p7__${echoWireName}`, rawName: echoWireName, description: '', inputSchema: { type: 'object' },
    call: args => mcp().call(echoWireName, args),
  }), echoWireName, '测试知识问答')
  assert.equal(overriddenDefinition.presentCall?.(echoedArgs).title, '测试知识问答')
  assert.equal(overriddenDefinition.presentResult?.(echoedArgs, echoed).title, '测试知识问答')
  receipt.checks.push('admin title override synchronized to DSH discovery and Chinese DSH call/result titles')

  const rediscovered = await admin(`/api/v1/model-admin/mcp-servers/${encodeURIComponent(server.id)}/discover`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: overridden.revision, reason: 'local DSH rediscovery fixture' }),
  })
  const afterRediscovery = await mcp().list()
  assert.equal(afterRediscovery.find(tool => tool.name === echoWireName)?.title, '测试知识问答')
  receipt.checks.push('rediscovery retained the admin title override')
  const published = await admin(`/api/v1/model-admin/mcp-servers/${encodeURIComponent(server.id)}/publish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: rediscovered.revision, reason: 'local DSH publish fixture', toolNames: [echoRawName, statusRawName] }),
  })
  assert.equal((await mcp().list()).find(tool => tool.name === echoWireName)?.title, '测试知识问答')
  receipt.checks.push('published discovery kept both tools in the DSH catalog')

  const stale = mcp()
  await stale.list()
  const revoked = await admin(`/api/v1/model-admin/access-keys/${encodeURIComponent(manifest.accessKeyId)}/mcp-grants`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId, toolNames: [echoRawName, statusRawName], enabled: false, expectedRevision: await grantRevision(manifest.accessKeyId, serverId), reason: 'local DSH revocation fixture' }),
  })
  assert.deepEqual(await stale.list(), [])
  await assert.rejects(() => echo.execute(echoedArgs, { signal: new AbortController().signal }), error => error instanceof P7McpError && error.status === 403)
  receipt.checks.push('P7 removed revoked tools from a stale DSH catalog and rejected the already-created DSH definition call')
  const regranted = await admin(`/api/v1/model-admin/access-keys/${encodeURIComponent(manifest.accessKeyId)}/mcp-grants`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverId, toolNames: [echoRawName, statusRawName], enabled: true, expectedRevision: await grantRevision(manifest.accessKeyId, serverId), reason: 'restore local DSH integration fixture' }),
  })
  assert.deepEqual((await mcp().list()).map(tool => tool.name).sort(), [echoWireName, statusWireName])
  receipt.checks.push('fixture grant restored with both tools enabled; override title remains available for browser testing')
  receipt.revisions = { initial: server.revision, overridden: overridden.revision, rediscovered: rediscovered.revision, published: published.revision, revoked: revoked.revision, regranted: regranted.revision }
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
