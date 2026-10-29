import type { ModelConfigV1, P7Connection } from './contracts.js'
import { ConfigValidationError, MAX_RESPONSE_BYTES, validateModelConfig } from './validate-config.js'

export type P7Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type P7FetchResult = { kind: 'snapshot'; config: ModelConfigV1; etag: string } | { kind: 'not-modified' }
export type P7ClientErrorCode = 'invalid-origin' | 'timeout' | 'network' | 'unauthorized' | 'forbidden' | 'http' | 'invalid-response'
export class P7ClientError extends Error {
  constructor(public readonly code: P7ClientErrorCode, public readonly status?: number, message?: string) { super(message ?? code); this.name = 'P7ClientError' }
}
export interface FetchConfigRequest extends P7Connection { etag?: string; hasSnapshot: boolean; signal?: AbortSignal }
export interface P7Client { fetchConfig(request: FetchConfigRequest): Promise<P7FetchResult> }
export function validateP7Origin(input: string): string {
  let url: URL
  try { url = new URL(input) } catch { throw new P7ClientError('invalid-origin') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new P7ClientError('invalid-origin')
  return url.origin
}
async function readLimitedBody(response: Response, limit: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const advertised = response.headers.get('Content-Length')
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) throw new P7ClientError('invalid-response')
  const reader = response.body?.getReader()
  if (!reader) throw new P7ClientError('invalid-response')
  const abort = () => { void reader.cancel() }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (signal.aborted) throw new Error('aborted')
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) { await reader.cancel(); throw new P7ClientError('invalid-response') }
      chunks.push(next.value)
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes.buffer
}
export function createP7Client(options: { fetch: P7Fetch; timeoutMs?: number; maxResponseBytes?: number }): P7Client {
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
  return {
    async fetchConfig(request) {
      const origin = validateP7Origin(request.origin)
      const once = async (etag?: string): Promise<P7FetchResult> => {
        const controller = new AbortController()
        let timedOut = false
        const abort = () => controller.abort()
        request.signal?.addEventListener('abort', abort, { once: true })
        const timeout = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        const finish = () => { clearTimeout(timeout); request.signal?.removeEventListener('abort', abort) }
        let response: Response
        try {
          response = await options.fetch(`${origin}/v1/desktop/model-config`, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', Authorization: `Bearer ${request.key}`, ...(etag ? { 'If-None-Match': etag } : {}) } })
        } catch {
          finish()
          throw new P7ClientError(timedOut ? 'timeout' : 'network')
        }
        if (response.status === 304) { finish(); return { kind: 'not-modified' } }
        if (response.status === 401) { finish(); throw new P7ClientError('unauthorized', 401) }
        if (response.status === 403) { finish(); throw new P7ClientError('forbidden', 403) }
        if (!response.ok) { finish(); throw new P7ClientError('http', response.status) }
        let buffer: ArrayBuffer
        try { buffer = await readLimitedBody(response, maxResponseBytes, controller.signal) } catch (error) { if (error instanceof P7ClientError) throw error; throw new P7ClientError(timedOut ? 'timeout' : 'network') } finally { finish() }
        if (buffer.byteLength > maxResponseBytes) throw new P7ClientError('invalid-response')
        let raw: unknown
        try { raw = JSON.parse(new TextDecoder().decode(buffer)) } catch { throw new P7ClientError('invalid-response') }
        let config: ModelConfigV1
        try { config = validateModelConfig(raw, buffer.byteLength) } catch (error) { throw new P7ClientError('invalid-response', undefined, error instanceof ConfigValidationError ? error.message : 'invalid-response') }
        const returnedEtag = response.headers.get('ETag')
        const revisionEtag = `"${config.revision}"`
        // gzip proxies may weaken an ETag without changing the decoded JSON.
        // Validate that exact revision and keep the origin's canonical token so
        // subsequent requests still match older P7 conditional-GET handlers.
        if (returnedEtag !== revisionEtag && returnedEtag !== `W/${revisionEtag}`) throw new P7ClientError('invalid-response')
        return { kind: 'snapshot', config, etag: revisionEtag }
      }
      const result = await once(request.etag)
      if (result.kind === 'not-modified' && !request.hasSnapshot) {
        const retry = await once()
        if (retry.kind === 'not-modified') throw new P7ClientError('invalid-response')
        return retry
      }
      return result
    },
  }
}
