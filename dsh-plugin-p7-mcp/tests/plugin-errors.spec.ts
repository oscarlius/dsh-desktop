import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'

type Invocation = { call(args: Record<string, unknown>, execution: { signal: AbortSignal }): Promise<unknown> }
vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ createMcpToolDefinition: (_ctx: unknown, options: unknown) => options }))
afterEach(() => { vi.unstubAllGlobals() })

it.each([502, 429, 403])('retains the HTTP %s category and only refreshes discovery after a real access rejection', async status => {
  const dir = await mkdtemp(join(tmpdir(), 'p7-mcp-errors-'))
  await writeFile(join(dir, '.p7-company-models.json'), JSON.stringify({ origin: 'https://p7.example' }))
  let listed = 0
  const definitions: Invocation[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { method: string; id?: string }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (request.method === 'tools/call') return new Response('supplier-secret', { status })
    if (request.method === 'tools/list') listed++
    const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18' }
      : { tools: [{ name: 'search__web_search', inputSchema: { type: 'object' } }] }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } })
  }))
  const ctx = new Context()
  ctx.provide('profileContext', { dir } as never)
  ctx.provide('credentials', { resolve: async () => undefined } as never)
  ctx.provide('p7Account', {
    usesPersonalToken: () => true, getValidAccessToken: async () => 'synthetic-token', subscribe: () => () => {},
  } as never)
  ctx.provide('tools', { register: (definition: Invocation) => { definitions.push(definition); return () => {} } } as never)
  const fiber = await ctx.plugin(plugin)
  try {
    await vi.waitFor(() => { expect(definitions).toHaveLength(1) })
    const error = await definitions[0]!.call({}, { signal: new AbortController().signal }).catch((e: unknown) => e)
    expect(error).toMatchObject({ status, code: status === 403 ? 'P7_TOOL_FORBIDDEN' : status === 429 ? 'P7_TOOL_BUSY' : 'P7_TOOL_UPSTREAM' })
    expect(String(error)).not.toContain('supplier-secret')
    if (status === 403) await vi.waitFor(() => { expect(listed).toBe(2) })
    else { await new Promise(resolve => setImmediate(resolve)); expect(listed).toBe(1) }
  } finally { await fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})
