import { describe, expect, it, vi } from 'vitest'
import { createP7Client, P7ClientError, validateP7Origin } from '../src/p7-client.js'
import { config } from './fixtures/config.js'

const response = (body: unknown, status = 200, headers: Record<string, string> = { ETag: '"revision-1"' }) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
describe('P7 config client', () => {
  it('uses strict same-origin fetch settings and bearer authentication only in the header', async () => {
    const fetch = vi.fn(async () => response(config()))
    const client = createP7Client({ fetch })
    await expect(client.fetchConfig({ origin: 'https://p7.example', key: 'p7k_secret', hasSnapshot: false })).resolves.toMatchObject({ kind: 'snapshot' })
    expect(fetch).toHaveBeenCalledWith('https://p7.example/v1/desktop/model-config', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer p7k_secret' }) }))
  })
  it('rejects unsafe origin forms before any request', () => {
    for (const origin of ['http://p7.example', 'https://user@p7.example', 'https://p7.example/path', 'https://p7.example/?x=1']) expect(() => validateP7Origin(origin)).toThrow(P7ClientError)
  })
  it('retries a 304 once without ETag only without a valid local snapshot', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 304 })).mockResolvedValueOnce(response(config()))
    await expect(createP7Client({ fetch }).fetchConfig({ origin: 'https://p7.example', key: 'p7k_secret', etag: '"old"', hasSnapshot: false })).resolves.toMatchObject({ kind: 'snapshot' })
    expect((fetch.mock.calls[1]?.[1] as RequestInit).headers).not.toHaveProperty('If-None-Match')
  })
  it('categorizes auth failures without error response content or key leakage', async () => {
    const client = createP7Client({ fetch: vi.fn(async () => new Response('p7k_secret private response', { status: 401 })) })
    await expect(client.fetchConfig({ origin: 'https://p7.example', key: 'p7k_secret', hasSnapshot: false })).rejects.toMatchObject({ code: 'unauthorized', status: 401, message: 'unauthorized' })
  })
  it('rejects an oversized advertised response before consuming its body', async () => {
    const body = new ReadableStream<Uint8Array>({ pull() {} })
    const client = createP7Client({ fetch: vi.fn(async () => new Response(body, { headers: { 'Content-Length': String(256 * 1024 + 1), ETag: '"revision-1"' } })) })
    await expect(client.fetchConfig({ origin: 'https://p7.example', key: 'p7k_secret', hasSnapshot: false })).rejects.toMatchObject({ code: 'invalid-response' })
  })
  it('cancels a streamed body as soon as its size exceeds the configured limit', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)) }, cancel() { cancelled = true } })
    const client = createP7Client({ fetch: vi.fn(async () => new Response(body, { headers: { ETag: '"revision-1"' } })), maxResponseBytes: 10 })
    await expect(client.fetchConfig({ origin: 'https://p7.example', key: 'p7k_secret', hasSnapshot: false })).rejects.toMatchObject({ code: 'invalid-response' })
    expect(cancelled).toBe(true)
  })
  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers()
    try {
      let observedAbort = false
      const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}) }, cancel() { observedAbort = true } })
      const client = createP7Client({ fetch: vi.fn(async () => new Response(body, { headers: { ETag: '"revision-1"' } })), timeoutMs: 10 })
      const pending = client.fetchConfig({ origin: 'https://p7.example', key: 'p7k_secret', hasSnapshot: false })
      const asserted = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(10)
      await asserted
      expect(observedAbort).toBe(true)
    } finally { vi.useRealTimers() }
  })
})
