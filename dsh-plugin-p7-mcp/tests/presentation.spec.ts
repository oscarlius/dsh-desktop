import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'

afterEach(() => { vi.unstubAllGlobals() })

it('presents managed MCP tools in Chinese without changing their wire identity or failure content', async () => {
  const prefix = 'p7-mcp-presentation-'
  const dir = await mkdtemp(join(tmpdir(), prefix))
  await writeFile(join(dir, '.p7-company-models.json'), JSON.stringify({ origin: 'https://p7.example' }))
  const definitions: ToolDefinition[] = []
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { method: string; id?: string; params?: { name: string; arguments: Record<string, unknown> } }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (request.method === 'tools/call') {
      calls.push(request.params!)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'source data' }] } }), { headers: { 'content-type': 'application/json' } })
    }
    const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [
      { name: 'jydb__get_daily_quotes', description: 'Daily prices.', inputSchema: { type: 'object' } },
      { name: 'vendor__unlisted_tool', description: 'Unlisted tool.', inputSchema: { type: 'object' } },
      { name: 'vendor__custom_tool', title: '服务端中文标题', _meta: { 'com.p7/server': { name: '业务平台', namespace: 'vendor' } }, inputSchema: { type: 'object' } },
    ] }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } })
  }))
  const ctx = new Context()
  ctx.provide('profileContext', { dir } as never)
  ctx.provide('credentials', { resolve: async () => undefined } as never)
  ctx.provide('p7Account', { usesPersonalToken: () => true, getValidAccessToken: async () => 'synthetic-token', subscribe: () => () => {} } as never)
  ctx.provide('tools', { register: (definition: ToolDefinition) => { definitions.push(definition); return () => {} } } as never)
  const fiber = await ctx.plugin(plugin)
  try {
    await vi.waitFor(() => { expect(definitions).toHaveLength(3) })
    const known = definitions.find(definition => definition.name === 'mcp__p7__jydb__get_daily_quotes')!
    const unknown = definitions.find(definition => definition.name === 'mcp__p7__vendor__unlisted_tool')!
    expect(known.name).toBe('mcp__p7__jydb__get_daily_quotes')
    expect(known.presentCall!({ symbol: '000001.SZ' })).toEqual({ card: 'generic', title: '日行情查询' })
    const failure = { content: [{ type: 'text' as const, text: 'upstream failure' }], isError: true as const }
    expect(known.presentResult!({}, failure)).toEqual({ card: 'generic', title: '日行情查询' })
    expect(failure).toEqual({ content: [{ type: 'text', text: 'upstream failure' }], isError: true })
    expect(unknown.presentCall!({})).toEqual({ card: 'generic', title: '公司工具调用' })
    expect(definitions.find(definition => definition.name === 'mcp__p7__vendor__custom_tool')!.presentCall!({})).toEqual({ card: 'generic', title: '服务端中文标题' })
    await known.execute({ symbol: '000001.SZ' }, { signal: new AbortController().signal } as never)
    expect(calls).toEqual([{ name: 'jydb__get_daily_quotes', arguments: { symbol: '000001.SZ' } }])
  } finally {
    await fiber.dispose()
    const target = resolve(dir)
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(prefix)) throw new Error('Unsafe test cleanup target')
    await rm(target, { recursive: true, force: true })
  }
})
