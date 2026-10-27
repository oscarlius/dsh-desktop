import { createHash, randomUUID } from 'node:crypto'

export interface McpConnection { origin: string; apiKey: string }
export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export type P7McpFailureCode = 'P7_AUTH_REQUIRED' | 'P7_TOOL_FORBIDDEN' | 'P7_TOOL_ARGUMENTS' | 'P7_TOOL_BUSY' | 'P7_TOOL_UPSTREAM' | 'P7_TOOL_UNAVAILABLE'
export class P7McpError extends Error {
  readonly code: P7McpFailureCode
  constructor(readonly status: number) {
    const [code, message] = status === 401 ? ['P7_AUTH_REQUIRED', '公司登录已失效，请重新登录公司账号。'] as const
      : status === 403 ? ['P7_TOOL_FORBIDDEN', '此公司工具当前未授权，请检查后台工具授权。'] as const
      : status === 422 ? ['P7_TOOL_ARGUMENTS', '公司工具的调用参数不符合要求，请检查参数后再试。'] as const
      : status === 429 ? ['P7_TOOL_BUSY', '公司工具服务繁忙或达到频率限制，请稍后再试，避免连续重试。'] as const
      : status === 502 || status === 504 ? ['P7_TOOL_UPSTREAM', '公司工具的上游服务暂不可用，请稍后再试，避免连续重试。'] as const
      : ['P7_TOOL_UNAVAILABLE', '公司工具服务暂不可用，请检查连接和服务状态。'] as const
    super(`${message}（HTTP ${status}）`)
    this.name = 'P7McpError'
    this.code = code
  }
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
    signal?.throwIfAborted()
    const connection = await this.connection()
    signal?.throwIfAborted()
    if (!connection.apiKey) throw new P7McpError(401)
    const identity = createHash('sha256').update(connection.origin + '\0' + connection.apiKey).digest('hex')
    if (identity !== this.initializedIdentity) {
      const result = await this.exchange(connection, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'dsh-p7-mcp', version: '2.0.18-beta.15' } }, signal)
      if (result.protocolVersion !== '2025-06-18') throw new P7McpError(502)
      signal?.throwIfAborted()
      const notified = await this.fetcher(new URL('/v1/mcp', connection.origin), { method: 'POST', redirect: 'error',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${connection.apiKey}` },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) })
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
    if (!isRecord(value) || value.jsonrpc !== '2.0' || value.id !== id) throw new P7McpError(502)
    // Only fixed protocol codes are interpreted. Supplier error text can contain
    // credentials or internal URLs and must never become an Agent/UI message.
    if (isRecord(value.error)) {
      throw new P7McpError(value.error.code === -32602 ? 422 : value.error.code === -32001 ? 403 : 502)
    }
    if (value.error || !isRecord(value.result)) throw new P7McpError(502)
    return value.result
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
