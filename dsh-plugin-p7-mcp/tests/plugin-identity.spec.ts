import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'

type Invocation = { call(args: Record<string, unknown>, execution: { signal: AbortSignal }): Promise<unknown> }
vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ createMcpToolDefinition: (_ctx: unknown, options: unknown) => options }))
afterEach(() => { vi.unstubAllGlobals() })

it.each([
  { label: 'account switch', changeIdentity: true },
  { label: 'same-account token renewal', changeIdentity: false },
])('handles $label during a pending credential resolution without crossing identities', async ({ changeIdentity }) => {
  const prefix = 'p7-mcp-identity-'
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(dir, '.p7-company-models.json'), JSON.stringify({ origin: 'https://p7.example' }))
  let token = 'synthetic-old-token'
  let blockNextResolution = false
  let releaseCredential: ((value: string) => void) | undefined
  let accountChanged: ((status: unknown) => void) | undefined
  let userId = 'synthetic-old-user'
  const status = () => ({ phase: 'signed-in', profile: { userId, organizationId: 'synthetic-org', deviceId: 'fixture-device',
    sessionId: 'fixture-session', role: 'employee', scopes: ['mcp'], displayName: 'Synthetic user' }, expiresAt: Date.now() + 60_000 })
  let businessCalls = 0
  const definitions: Invocation[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { method: string; id?: string }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (request.method === 'tools/call') businessCalls++
    const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18' }
      : { tools: [{ name: 'jydb__get_daily_quotes', inputSchema: { type: 'object' } }] }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } })
  }))
  const ctx = new Context()
  ctx.provide('profileContext', { dir } as never)
  ctx.provide('credentials', { resolve: async () => undefined } as never)
  ctx.provide('p7Account', {
    usesPersonalToken: () => true,
    status,
    getValidAccessToken: async () => {
      if (!blockNextResolution) return token
      blockNextResolution = false
      return await new Promise<string>(complete => { releaseCredential = complete })
    },
    subscribe: (listener: (status: unknown) => void) => { accountChanged = listener; return () => {} },
  } as never)
  ctx.provide('tools', { register: (definition: Invocation) => { definitions.push(definition); return () => {} } } as never)
  const fiber = await ctx.plugin(plugin)
  try {
    await vi.waitFor(() => { expect(definitions).toHaveLength(1) })
    blockNextResolution = true
    const pending = definitions[0]!.call({}, { signal: new AbortController().signal }).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(releaseCredential).toBeTypeOf('function') })
    token = 'synthetic-new-token'
    if (changeIdentity) userId = 'synthetic-new-user'
    accountChanged!(status())
    releaseCredential!(token)
    const error = await pending
    expect(error instanceof Error).toBe(changeIdentity)
    expect(String(error)).not.toContain(token)
    expect(businessCalls).toBe(changeIdentity ? 0 : 1)
  } finally {
    await fiber.dispose()
    const target = resolve(dir)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(prefix)) throw new Error('Unsafe test cleanup target')
    await rm(target, { recursive: true, force: true })
  }
})

it('waits for AgentRegistry before publishing an on-demand catalog', async () => {
  const prefix = 'p7-mcp-readiness-'
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(dir, '.p7-company-models.json'), JSON.stringify({ origin: 'https://p7.example' }))
  const names: string[] = []
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
    requests++
    const request = JSON.parse(String(init.body)) as { method: string; id?: string }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18' }
      : { tools: [{ name: 'jydb__get_daily_quotes', inputSchema: { type: 'object' } }] }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } })
  }))
  const ctx = new Context()
  ctx.provide('profileContext', { dir } as never)
  ctx.provide('credentials', { resolve: async () => undefined } as never)
  ctx.provide('p7Account', {
    usesPersonalToken: () => true, getValidAccessToken: async () => 'synthetic-token', subscribe: () => () => {},
  } as never)
  ctx.provide('tools', {
    register: (definition: { name: string }) => { names.push(definition.name); return () => {} },
    resolve: async () => {}, guard: () => () => {}, schemas: () => [], get: () => undefined,
  } as never)
  ctx.provide('systemPrompt', {
    section: () => () => {}, getSectionOrder: () => 500,
  } as never)
  const fiber = await ctx.plugin(plugin, { mode: 'on-demand' })
  try {
    await new Promise(complete => setImmediate(complete))
    expect(names).toEqual([])
    expect(requests).toBe(0)
    ctx.provide('agents', { list: () => [] } as never)
    await vi.waitFor(() => { expect(names).toEqual(['p7_mcp_search', 'p7_mcp_load', 'mcp__p7__jydb__get_daily_quotes']) })
  } finally {
    await fiber.dispose()
    const target = resolve(dir)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(prefix)) throw new Error('Unsafe test cleanup target')
    await rm(target, { recursive: true, force: true })
  }
})
