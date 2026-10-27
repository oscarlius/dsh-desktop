import { describe, expect, it } from 'vitest'
import { P7McpClient, P7McpError } from '../src/client.js'

const tool = { name: 'search__web_search', description: 'Company search', inputSchema: { type: 'object' } }
function server(options: { tools?: unknown[]; wrongId?: boolean; oversized?: boolean; status?: number } = {}): { fetcher: typeof fetch; calls: Array<{ authorization: string | null; method: string }> } {
  const calls: Array<{ authorization: string | null; method: string }> = []
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: string }
    calls.push({ authorization: new Headers(init?.headers).get('authorization'), method: body.method })
    if (options.status) return new Response('', { status: options.status })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18' }
      : body.method === 'tools/list' ? { tools: options.tools ?? [tool] }
      : { content: [{ type: 'text', text: options.oversized ? 'x'.repeat(1_048_576) : 'source data' }], isError: false }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: options.wrongId ? 'other' : body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  return { fetcher, calls }
}

describe('P7 managed MCP client', () => {
  it('initializes and discovers, then resolves the current personal credential for every call', async () => {
    let token = 'test-person-a'; const wire = server()
    const client = new P7McpClient(async () => ({ origin: 'https://p7.example', apiKey: token }), wire.fetcher)
    expect(await client.list()).toEqual([tool])
    expect(wire.calls.map(call => call.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    token = 'test-person-refreshed'
    expect((await client.call(tool.name, { query: 'test' })).isError).toBe(false)
    expect(wire.calls.at(-1)?.authorization).toBe('Bearer test-person-refreshed')
    expect(wire.calls.filter(call => call.method === 'initialize')).toHaveLength(2)
  })
  it('blocks the network after logout rather than reusing the previous credential', async () => {
    let token = 'test-active'; const wire = server()
    const client = new P7McpClient(async () => ({ origin: 'https://p7.example', apiKey: token }), wire.fetcher)
    await client.list(); const before = wire.calls.length; token = ''
    await expect(client.call(tool.name, {})).rejects.toMatchObject({ status: 401 })
    expect(wire.calls).toHaveLength(before)
  })
  it('cancels initialization notification without dispatching the tool call', async () => {
    const controller = new AbortController()
    const methods: string[] = []
    let notificationStarted!: () => void
    const started = new Promise<void>(resolve => { notificationStarted = resolve })
    const client = new P7McpClient(async () => ({ origin: 'https://p7.example', apiKey: 'test' }), async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; id?: string }
      methods.push(request.method)
      if (request.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json' } })
      notificationStarted()
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
      })
    })
    const call = client.call(tool.name, {}, controller.signal)
    const rejection = expect(call).rejects.toMatchObject({ name: 'AbortError' })
    await started
    controller.abort()
    await rejection
    expect(methods).toEqual(['initialize', 'notifications/initialized'])
  })
  it('rejects duplicate advertised tools and a response for another request', async () => {
    const connection = async () => ({ origin: 'https://p7.example', apiKey: 'test' })
    await expect(new P7McpClient(connection, server({ tools: [tool, tool] }).fetcher).list()).rejects.toBeInstanceOf(P7McpError)
    await expect(new P7McpClient(connection, server({ wrongId: true }).fetcher).list()).rejects.toBeInstanceOf(P7McpError)
  })
  it('bounds actual response bytes, including a response without Content-Length', async () => {
    const wire = server({ oversized: true })
    const client = new P7McpClient(async () => ({ origin: 'https://p7.example', apiKey: 'test' }), wire.fetcher)
    await expect(client.call(tool.name, {})).rejects.toMatchObject({ status: 502 })
  })
  it('does not expose upstream credential-bearing error bodies', async () => {
    const wire = server({ status: 403 })
    const client = new P7McpClient(async () => ({ origin: 'https://p7.example', apiKey: 'test-secret' }), wire.fetcher)
    await expect(client.list()).rejects.toThrow('此公司工具当前未授权')
  })
  it.each([
    [401, 'P7_AUTH_REQUIRED'], [403, 'P7_TOOL_FORBIDDEN'], [422, 'P7_TOOL_ARGUMENTS'],
    [429, 'P7_TOOL_BUSY'], [502, 'P7_TOOL_UPSTREAM'], [503, 'P7_TOOL_UNAVAILABLE'], [504, 'P7_TOOL_UPSTREAM'],
  ])('classifies HTTP %s without echoing a server error body', async (status, code) => {
    const client = new P7McpClient(async () => ({ origin: 'https://p7.example', apiKey: 'test-secret' }),
      async () => new Response('Bearer test-secret http://internal.invalid/private', { status: Number(status) }))
    const error = await client.list().catch((e: unknown) => e)
    expect(error).toMatchObject({ status, code })
    expect(String(error)).not.toContain('test-secret')
    expect(String(error)).not.toContain('internal.invalid')
    if (status === 502 || status === 429) expect(String(error)).not.toContain('未授权')
  })
  it.each([[-32602, 422], [-32001, 403], [-32002, 502]])('classifies JSON-RPC %s and drops its untrusted message', async (rpcCode, status) => {
    const wire = server()
    const client = new P7McpClient(async () => ({ origin: 'https://p7.example', apiKey: 'test' }), async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id?: string }
      if (body.method !== 'tools/call') return wire.fetcher(url, init)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: rpcCode, message: 'supplier-secret' } }), { headers: { 'content-type': 'application/json' } })
    })
    const error = await client.call(tool.name, {}).catch((e: unknown) => e)
    expect(error).toMatchObject({ status })
    expect(String(error)).not.toContain('supplier-secret')
  })
})
