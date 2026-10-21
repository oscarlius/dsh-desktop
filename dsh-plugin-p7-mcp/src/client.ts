import { createHash, randomUUID } from 'node:crypto'

export interface McpConnection { origin: string; apiKey: string }
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export class P7McpError extends Error {
  constructor(readonly status: number) { super('Company MCP service is unavailable or this tool is no longer authorized.') }
}

/** The connection resolver is called for every operation; no token snapshot survives refresh/logout. */
export class P7McpClient {
  private initializedIdentity = ''
  constructor(private readonly connection: () => Promise<McpConnection>, private readonly fetcher: typeof fetch = fetch) {}
  async list(): Promise<McpTool[]> {
    const result = await this.rpc('tools/list', {})
    if (!Array.isArray(result.tools) || result.tools.length > 128) throw new P7McpError(502)
    const names = new Set<string>()
    return result.tools.map((tool: unknown) => {
      if (!isRecord(tool) || typeof tool.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name)
        || names.has(tool.name) || !isRecord(tool.inputSchema)) throw new P7McpError(502)
      names.add(tool.name)
      return { name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', inputSchema: tool.inputSchema }
    })
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.rpc('tools/call', { name, arguments: args }, signal)
  }
  private async rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const connection = await this.connection()
    if (!connection.apiKey) throw new P7McpError(401)
    const identity = createHash('sha256').update(connection.origin + '\0' + connection.apiKey).digest('hex')
    if (identity !== this.initializedIdentity) {
      const result = await this.exchange(connection, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'dsh-p7-mcp', version: '2.0.18-beta.15' } }, signal)
      if (result.protocolVersion !== '2025-06-18') throw new P7McpError(502)
      const notified = await this.fetcher(new URL('/v1/mcp', connection.origin), { method: 'POST', redirect: 'error',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${connection.apiKey}` },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(10_000) })
      await notified.body?.cancel()
      if (notified.status !== 202) throw new P7McpError(notified.status)
      this.initializedIdentity = identity
    }
    return await this.exchange(connection, method, params, signal)
  }
  private async exchange(connection: McpConnection, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const origin = new URL(connection.origin)
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new P7McpError(400)
    const id = randomUUID()
    const response = await this.fetcher(new URL('/v1/mcp', origin), {
      method: 'POST', redirect: 'error',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        authorization: `Bearer ${connection.apiKey}`, 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(125_000)]) : AbortSignal.timeout(125_000),
    })
    if (!response.ok) { await response.body?.cancel(); throw new P7McpError(response.status) }
    if (!response.headers.get('content-type')?.startsWith('application/json')) { await response.body?.cancel(); throw new P7McpError(502) }
    const reader = response.body?.getReader()
    if (!reader) throw new P7McpError(502)
    const chunks: Uint8Array[] = []; let total = 0
    try {
      while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength
        if (total > 1_048_576) throw new P7McpError(502); chunks.push(part.value) }
    } finally { await reader.cancel().catch(() => undefined) }
    const bytes = new Uint8Array(total); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new P7McpError(502) }
    if (!isRecord(value) || value.jsonrpc !== '2.0' || value.id !== id || value.error || !isRecord(value.result)) throw new P7McpError(502)
    return value.result
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
