import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_SELF_ACCESS_HEADER,
  createHostSelfAccess,
  installHostSelfFetch,
} from '../src/host-self-fetch.ts'

const servers: Server[] = []
const cleanups: (() => void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()!()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

async function listen(handler: RequestHandler): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not expose an address')
  return `http://127.0.0.1:${String(address.port)}`
}

describe('Host self-fetch capability', () => {
  it('stamps only its initial exact origin and preserves request semantics', async () => {
    const received: Array<{ header: string | undefined; method: string | undefined; body: string }> = []
    const origin = await listen(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      received.push({ header: req.headers[HOST_SELF_ACCESS_HEADER] as string | undefined, method: req.method, body })
      res.end('ok')
    })
    const adjacent = await listen((req, res) => {
      received.push({ header: req.headers[HOST_SELF_ACCESS_HEADER] as string | undefined, method: req.method, body: '' })
      res.end('adjacent')
    })
    const access = createHostSelfAccess(Buffer.alloc(32, 8).toString('base64url'))
    cleanups.push(installHostSelfFetch(origin, access))

    const request = new Request(`${origin}/self`, { method: 'POST', body: 'payload', signal: AbortSignal.timeout(2_000) })
    expect((await fetch(request)).status).toBe(200)
    expect((await fetch(`${adjacent}/adjacent`)).status).toBe(200)
    expect(received).toEqual([
      { header: access.token, method: 'POST', body: 'payload' },
      { header: undefined, method: 'GET', body: '' },
    ])
  })

  it('fails closed on automatic redirects but leaves explicit manual redirects available', async () => {
    const external = await listen((_req, res) => { res.end('external') })
    const origin = await listen((req, res) => {
      if (req.url === '/self-redirect') res.writeHead(302, { location: `${external}/outside` }).end()
      else res.end('ok')
    })
    cleanups.push(installHostSelfFetch(origin, createHostSelfAccess(Buffer.alloc(32, 9).toString('base64url'))))

    await expect(fetch(`${origin}/self-redirect`)).rejects.toThrow()
    const manual = await fetch(`${origin}/self-redirect`, { redirect: 'manual' })
    expect(manual.status).toBe(302)
  })

  it('does not gain capability when an external request redirects into the Host', async () => {
    const host = await listen((req, res) => {
      if (req.headers[HOST_SELF_ACCESS_HEADER] === undefined) res.statusCode = 403
      res.end('host')
    })
    const external = await listen((_req, res) => { res.writeHead(302, { location: `${host}/target` }).end() })
    cleanups.push(installHostSelfFetch(host, createHostSelfAccess(Buffer.alloc(32, 10).toString('base64url'))))

    expect((await fetch(`${external}/redirect`)).status).toBe(403)
  })

  it('delegates external Request stream bodies unchanged to the captured fetch', async () => {
    const nativeFetch = globalThis.fetch
    const capturedFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response('external'))
    globalThis.fetch = capturedFetch as typeof fetch
    try {
      const uninstall = installHostSelfFetch('http://127.0.0.1:1', createHostSelfAccess(Buffer.alloc(32, 13).toString('base64url')))
      const request = new Request('https://example.invalid/external', {
        method: 'POST',
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream body')); controller.close() } }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })

      await fetch(request)

      expect(capturedFetch).toHaveBeenCalledOnce()
      expect(capturedFetch.mock.calls[0]?.[0]).toBe(request)
      expect(capturedFetch.mock.calls[0]?.[1]).toBeUndefined()
      await expect(request.text()).resolves.toBe('stream body')
      uninstall()
    } finally {
      globalThis.fetch = nativeFetch
    }
  })

  it('restores fetch on disposal and uses a fresh capability for a new generation', async () => {
    const headers: string[] = []
    const origin = await listen((req, res) => {
      headers.push(String(req.headers[HOST_SELF_ACCESS_HEADER] ?? ''))
      res.end('ok')
    })
    const first = createHostSelfAccess(Buffer.alloc(32, 11).toString('base64url'))
    const firstCleanup = installHostSelfFetch(origin, first)
    await fetch(`${origin}/first`)
    firstCleanup()
    await fetch(`${origin}/none`)
    const second = createHostSelfAccess(Buffer.alloc(32, 12).toString('base64url'))
    cleanups.push(installHostSelfFetch(origin, second))
    await fetch(`${origin}/second`)

    expect(headers).toEqual([first.token, '', second.token])
    expect(second.token).not.toBe(first.token)
  })
})
