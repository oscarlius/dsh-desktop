import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CompanyHost } from './company-host.js'
import { API_PATHS } from './http-contract.js'
import type { AccountBroker } from './account-broker.js'

export interface CompanyWebServer {
  getOrigin(): string
  register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void
}
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(value))
}
function sameOrigin(req: IncomingMessage, expected: string, mutating: boolean): boolean {
  const origin = new URL(expected)
  if (!['127.0.0.1', '[::1]'].includes(origin.hostname)) return false
  const remote = req.socket.remoteAddress
  if (!(remote === '::1' || remote?.startsWith('127.') || remote?.startsWith('::ffff:127.'))) return false
  if (req.headers.host !== origin.host || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return false
  if (req.headers.origin === expected) return true
  if (mutating || req.headers['sec-fetch-site'] !== 'same-origin') return false
  try { return new URL(req.headers.referer ?? '').origin === expected } catch { return false }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('invalid-body')
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > 8192)) throw new Error('invalid-body')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > 8192) throw new Error('invalid-body')
    chunks.push(bytes)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid-body')
  return value as Record<string, unknown>
}
/** Loopback + browser-origin admission protects the write-only key submission. */
export function registerCompanyRoutes(server: CompanyWebServer, host: Pick<CompanyHost, 'status' | 'connect' | 'sync' | 'disconnect'>, account?: Pick<AccountBroker, 'status' | 'login' | 'logout' | 'usage'>): () => void {
  const remove = Object.entries(API_PATHS).map(([action, path]) => server.register({
    kind: 'exact', path,
    async handler(req, res) {
      const method = action === 'status' || action === 'accountStatus' || action === 'accountUsage' ? 'GET' : 'POST'
      if (req.method !== method) { res.setHeader('allow', method); reply(res, 405, { error: 'Method not allowed.' }); return }
      if (!sameOrigin(req, server.getOrigin(), method === 'POST')) { reply(res, 403, { error: 'Request origin is not allowed.' }); return }
      try {
        if (action === 'accountStatus') { if (!account) throw new Error('account unavailable'); reply(res, 200, account.status()); return }
        if (action === 'accountUsage') {
          if (!account) throw new Error('account unavailable')
          const url = new URL(req.url ?? '', server.getOrigin()); const from = url.searchParams.get('from'); const to = url.searchParams.get('to'); const groupBy = url.searchParams.get('groupBy')
          if (!from || !to || (groupBy !== null && groupBy !== 'day' && groupBy !== 'model' && groupBy !== 'service')) throw new Error('invalid-body')
          reply(res, 200, await account.usage(from, to, groupBy ?? 'day')); return
        }
        if (action === 'accountLogin') { if (!account) throw new Error('account unavailable'); if (Object.keys(await body(req)).length) throw new Error('invalid-body'); reply(res, 200, await account.login()); return }
        if (action === 'accountLogout') { if (!account) throw new Error('account unavailable'); if (Object.keys(await body(req)).length) throw new Error('invalid-body'); await account.logout(); reply(res, 200, account.status()); return }
        if (action !== 'status') {
          const value = await body(req)
          if (action === 'connect') {
            if (Object.keys(value).length !== 2 || typeof value.origin !== 'string' || typeof value.apiKey !== 'string') throw new Error('invalid-body')
            await host.connect(value.origin, value.apiKey)
          } else {
            if (Object.keys(value).length) throw new Error('invalid-body')
            if (action === 'sync') await host.sync()
            else await host.disconnect()
          }
        }
        reply(res, 200, host.status())
      } catch { reply(res, 422, { error: 'P7 settings could not be applied. Check the connection and profile configuration.' }) }
    },
  }))
  return () => { for (const dispose of remove.reverse()) dispose() }
}
