import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCoreCookieBroker, registerBootstrapRoute } from '../src/bootstrap-route.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function stateFile(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'dsh-web-bootstrap-')); roots.push(root); return join(root, 'core-cookie.json') }

it('serves a fresh stored cookie without minting', async () => {
  const file = await stateFile()
  await writeFile(file, JSON.stringify({ cookie: 'dsh=fresh', expiresAt: Date.now() + 48 * 3_600_000 }))
  const mint = vi.fn()
  const broker = createCoreCookieBroker({ file, mint })
  await expect(broker.getCookie()).resolves.toBe('dsh=fresh')
  expect(mint).not.toHaveBeenCalled()
})

it('renews an expiring cookie through the launch token and persists it', async () => {
  const file = await stateFile()
  await writeFile(file, JSON.stringify({ cookie: 'dsh=old', expiresAt: Date.now() + 1_000 }))
  const minted = { cookie: 'dsh=renewed', expiresAt: Date.now() + 30 * 86_400_000 }
  const broker = createCoreCookieBroker({ file, mint: async () => minted })
  await expect(broker.getCookie()).resolves.toBe('dsh=renewed')
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(minted)
})

it('renews when the state file is missing or corrupt', async () => {
  const file = await stateFile()
  await writeFile(file, 'not json')
  const broker = createCoreCookieBroker({ file, mint: async () => ({ cookie: 'dsh=minted', expiresAt: Date.now() + 86_400_000 }) })
  await expect(broker.getCookie()).resolves.toBe('dsh=minted')
})

it('fails closed when renewal fails', async () => {
  const file = await stateFile()
  const broker = createCoreCookieBroker({ file, mint: async () => { throw new Error('no token') } })
  await expect(broker.getCookie()).resolves.toBeUndefined()
})

it('shares one renewal across concurrent polls', async () => {
  const file = await stateFile()
  let release!: (value: { cookie: string; expiresAt: number }) => void
  const mint = vi.fn(() => new Promise<{ cookie: string; expiresAt: number }>(resolve => { release = resolve }))
  const broker = createCoreCookieBroker({ file, mint })
  const first = broker.getCookie(); const second = broker.getCookie()
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1))
  release({ cookie: 'dsh=shared', expiresAt: Date.now() + 86_400_000 })
  await expect(first).resolves.toBe('dsh=shared')
  await expect(second).resolves.toBe('dsh=shared')
  expect(mint).toHaveBeenCalledTimes(1)
})

function mockResponse() {
  return { statusCode: 0, headers: {} as Record<string, string>, body: '', setHeader(name: string, value: string) { this.headers[name] = value }, end(body: string) { this.body = body } }
}

it('rejects requests without the controller token as unavailable', async () => {
  const handlers = new Map<string, (req: never, res: never) => Promise<void>>()
  const server = { register(route: { kind: 'exact'; path: string; handler(req: never, res: never): Promise<void> }) { handlers.set(route.path, route.handler); return () => {} } }
  registerBootstrapRoute(server as never, createCoreCookieBroker({ mint: async () => ({ cookie: 'dsh=x', expiresAt: 1 }) }))
  const handler = handlers.get('/p7-web-host/internal/bootstrap')!
  const response = mockResponse()
  await handler({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never, response as never)
  expect(response.statusCode).toBe(503)
})

it('answers non-GET methods with 405', async () => {
  const handlers = new Map<string, (req: never, res: never) => Promise<void>>()
  const server = { register(route: { kind: 'exact'; path: string; handler(req: never, res: never): Promise<void> }) { handlers.set(route.path, route.handler); return () => {} } }
  registerBootstrapRoute(server as never, createCoreCookieBroker({ mint: async () => ({ cookie: 'dsh=x', expiresAt: 1 }) }))
  const handler = handlers.get('/p7-web-host/internal/bootstrap')!
  const response = mockResponse()
  await handler({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never, response as never)
  expect(response.statusCode).toBe(405)
  expect(response.headers.allow).toBe('GET')
})
