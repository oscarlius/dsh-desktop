/**
 * Egress proof: a P7 search leaves through the proxy the launch environment names,
 * not directly to the gateway, and the access key never reaches anything a proxy
 * operator can read. Mirrors the Exa provider's egress test; the target is a
 * reserved `.invalid` name, so a direct attempt could only ever fail.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { P7SearchProvider } from '../src/provider.js'
import type { P7ResolvedConnection } from '../src/connection.js'

const PROBE_KEY = 'p7k_egress_probe_never_sent_as_text'
const PROBE_ORIGIN = 'https://p7-egress.invalid'

let seen: string[] = []
let proxy: Server
let proxyUrl = ''

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502); response.end('fake-proxy')
  })
  // An HTTPS target reaches the proxy as CONNECT, so the authority is all that
  // is observable — which is exactly what proves the request was not direct.
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); socket.end()
  })
  const a = await new Promise<AddressInfo>((r) => { proxy.listen(0, '127.0.0.1', () => { r(proxy.address() as AddressInfo) }) })
  proxyUrl = `http://127.0.0.1:${String(a.port)}`
})
afterAll(async () => { await new Promise<void>((r) => { proxy.close(() => { r() }) }) })

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}
async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
  try { await run().catch(() => undefined) } finally { await dispose() }
  return seen
}

function probeConnection(): P7ResolvedConnection {
  return { origin: PROBE_ORIGIN, apiKey: PROBE_KEY, requestTimeoutMs: 10_000 }
}

describe('p7 web-search egress', () => {
  it('reaches the gateway through the proxy instead of directly', async () => {
    const connection = probeConnection()
    const provider = new P7SearchProvider({
      connection: { peek: () => connection, resolve: async () => connection },
      credentialRef: 'P7_DSH_EGRESSPROBE_API_KEY',
    })
    const observed = await observe(() => provider.search({ query: 'probe' }))
    expect(observed).toHaveLength(1)
    expect(observed[0]).toContain('p7-egress.invalid')
  })

  it('keeps the bearer key out of anything the proxy observes', async () => {
    const connection = probeConnection()
    const provider = new P7SearchProvider({
      connection: { peek: () => connection, resolve: async () => connection },
      credentialRef: 'P7_DSH_EGRESSPROBE_API_KEY',
    })
    const observed = await observe(() => provider.search({ query: 'probe' }))
    expect(observed.join('\n')).not.toContain(PROBE_KEY)
  })
})
