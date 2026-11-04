import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { API_PATHS } from '../src/http-contract.js'
import { registerCompanyRoutes, type CompanyWebServer } from '../src/routes.js'
import { PERSONAL_MEMORY_ROUTE_PATHS, registerPersonalMemoryRoutes } from '../src/personal-memory-routes.js'

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

describe('personal memory loopback routes', () => {
  it('forwards only same-origin owner requests, validates mutation bodies, and derives a project workspace key', async () => {
    const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>(); let origin = ''
    const web: CompanyWebServer = { getOrigin: () => origin, register: route => { handlers.set(route.path, route.handler); return () => { handlers.delete(route.path) } } }
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(input).includes('/status') ? { syncEnabled: true, itemCount: 0, sizeBytes: 0, maxBytes: 1, maxItems: 1, userId: 'u', organizationId: 'o', rawChatCapture: false } : { id: 'm1', revision: 1, kind: 'document', workspaceKey: 'project:hash', title: 'Title', content: 'Body', sourceId: 'manual:m1', deleted: false, updatedAt: 'now', userId: 'u', organizationId: 'o' }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const account = { status: () => ({ profile: { userId: 'u', organizationId: 'o' } }), connection: () => ({ origin: 'https://p7.example' }), getValidAccessToken: async () => 'personal-token' }
    const dispose = registerPersonalMemoryRoutes(web, account as never)
    const server = createServer((req, res) => { const [path = ''] = (req.url ?? '').split('?'); const handler = handlers.get(path); if (!handler) { res.statusCode = 404; res.end(); return }; void handler(req, res) })
    const port = await listen(server); origin = `http://127.0.0.1:${port}`
    try {
      const denied = await call(port, PERSONAL_MEMORY_ROUTE_PATHS.status, 'GET', { Host: `127.0.0.1:${port}` })
      expect(denied.status).toBe(403)
      const invalid = await call(port, PERSONAL_MEMORY_ROUTE_PATHS.put, 'POST', { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ id: 'm1' }))
      expect(invalid.status).toBe(422)
      const invalidWorkspace = await call(port, PERSONAL_MEMORY_ROUTE_PATHS.put, 'POST', { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ id: 'm1', kind: 'document', workspaceKey: 'project:not-server-valid', title: 'Title', content: 'Body', sourceId: 'manual:m1', expectedRevision: 0 }))
      expect(invalidWorkspace.status).toBe(422)
      const saved = await call(port, PERSONAL_MEMORY_ROUTE_PATHS.put, 'POST', { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ id: 'm1', kind: 'document', projectKey: 'Finance', title: 'Title', content: 'Body', sourceId: 'manual:m1', expectedRevision: 0 }))
      expect(saved.status).toBe(200)
      const [, init] = fetcher.mock.calls[0]!
      expect(init?.headers).toMatchObject({ authorization: 'Bearer personal-token' })
      expect(String(init?.body)).toMatch(/[a-f0-9]{64}/)
      expect(String(init?.body)).not.toContain('Finance')
      const dreams = await call(port, PERSONAL_MEMORY_ROUTE_PATHS.dreams, 'GET', { Host: `127.0.0.1:${port}`, Origin: origin })
      expect(dreams.status).toBe(200)
      const invalidReview = await call(port, PERSONAL_MEMORY_ROUTE_PATHS.dreamReview, 'POST', { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ id: 'dream-1', decision: 'accept', workspaceKey: 'not-a-workspace' }))
      expect(invalidReview.status).toBe(422)
      const review = await call(port, PERSONAL_MEMORY_ROUTE_PATHS.dreamReview, 'POST', { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ id: 'dream-1', decision: 'reject' }))
      expect(review.status).toBe(200)
      expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain('/dreams/dream-1/review')
    } finally { dispose(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllGlobals() }
  })
})
