import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { API_PATHS } from '../src/http-contract.js'
import { registerCompanyRoutes, type CompanyWebServer } from '../src/routes.js'

const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as import('node:net').AddressInfo).port))
})
const call = (port: number, path: string, method: string, headers: Record<string, string> = {}, payload?: string) => new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers })) })
  req.once('error', reject); req.end(payload)
})

const createApp = async () => {
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  let origin = ''
  const web: CompanyWebServer = { getOrigin: () => origin, register: route => { handlers.set(route.path, route.handler); return () => { handlers.delete(route.path) } } }
  const host = { status: vi.fn(() => ({ phase: 'ready', origin: 'https://p7.example', revision: 'r1', lastSyncedAt: null, defaultModel: 'admin', models: [], tools: { phase: 'registered', tools: [{ name: 'mcp__p7__search__web_search' }] }, message: null })), connect: vi.fn(async () => {}), sync: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) }
  const dispose = registerCompanyRoutes(web, host as never)
  const server = createServer((req, res) => { const handler = handlers.get(req.url ?? ''); if (!handler) { res.statusCode = 404; res.end(); return }; void handler(req, res) })
  const port = await listen(server); origin = `http://127.0.0.1:${port}`
  return { port, origin, host, close: async () => { dispose(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

describe('company host routes', () => {
  it('serves status only to the loopback same origin and enforces methods', async () => {
    const app = await createApp()
    try {
      const denied = await call(app.port, API_PATHS.status, 'GET', { Host: `127.0.0.1:${app.port}` })
      expect(denied.status).toBe(403)
      const allowed = await call(app.port, API_PATHS.status, 'GET', { Host: `127.0.0.1:${app.port}`, Origin: app.origin })
      expect(allowed.status).toBe(200)
      expect(allowed.headers['cache-control']).toBe('no-store')
      expect(allowed.body).toContain('mcp__p7__search__web_search')
      const method = await call(app.port, API_PATHS.status, 'POST', { Host: `127.0.0.1:${app.port}`, Origin: app.origin })
      expect(method.status).toBe(405); expect(method.headers.allow).toBe('GET')
    } finally { await app.close() }
  })

  it('validates write body content type and size, while never echoing a submitted key', async () => {
    const app = await createApp(); const secret = 'p7k_do-not-echo'
    try {
      const invalidType = await call(app.port, API_PATHS.connect, 'POST', { Host: `127.0.0.1:${app.port}`, Origin: app.origin, 'Content-Type': 'text/plain' }, JSON.stringify({ origin: 'https://p7.example', apiKey: secret }))
      expect(invalidType.status).toBe(422)
      const oversized = await call(app.port, API_PATHS.connect, 'POST', { Host: `127.0.0.1:${app.port}`, Origin: app.origin, 'Content-Type': 'application/json' }, 'x'.repeat(8193))
      expect(oversized.status).toBe(422)
      const response = await call(app.port, API_PATHS.connect, 'POST', { Host: `127.0.0.1:${app.port}`, Origin: app.origin, 'Content-Type': 'application/json' }, JSON.stringify({ origin: 'https://p7.example', apiKey: secret }))
      expect(response.status).toBe(200); expect(app.host.connect).toHaveBeenCalledWith('https://p7.example', secret); expect(response.body).not.toContain(secret)
    } finally { await app.close() }
  })
})
