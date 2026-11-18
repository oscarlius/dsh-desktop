/**
 * `P7SearchProvider`: a `WebSearchProvider` that searches through the P7 platform
 * gateway (`POST {origin}/v1/desktop/web-search`), which authenticates the desktop
 * access key, owns the search policy, and reaches a self-hosted SearXNG through its
 * own governed egress. The gateway generates no answer text, so `content` is omitted;
 * its `url` is the only field a result is promised, so entries are mapped without
 * inventing a snippet, and only entries with no usable http(s) URL are dropped.
 * @module dsh-plugin-p7-web-search/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import {
  isValidP7Origin,
  normalizeP7Origin,
  P7_MAX_ERROR_BODY_BYTES,
  P7_MAX_RESPONSE_BYTES,
  P7_PROVIDER_ID,
  P7_WEB_SEARCH_PATH,
} from './connection.js'
import type { P7ResolvedConnection } from './connection.js'
import type { P7SearchRequestBody } from './types.js'

/** Injectable fetch, defaulting to the platform's; mirrors the P7 config client's seam. */
export type P7Fetch = (input: RequestInfo | URL, init: RequestInit) => Promise<Response>

/** Options the plugin's `apply` supplies; every value is already resolved from its layers. */
export interface P7SearchProviderOptions {
  /**
   * Live connection: {@link P7ConnectionResolver.peek} backs the cheap
   * availability check, and the per-operation view backs the request, so a
   * credential change reaches the next search without re-registering.
   */
  connection: {
    peek(): P7ResolvedConnection
    resolve(): Promise<P7ResolvedConnection>
    hasPendingCredentialRefresh?(): boolean
  }
  /** Credential reference named by missing-key diagnostics — a name, never a value. */
  credentialRef: string
  /** Test seam for transport; production uses `globalThis.fetch`. */
  fetch?: P7Fetch
}

/** Machine-readable failure codes, mapped from the frozen contract's five codes. */
const CODE_HINTS: Readonly<Record<string, string>> = {
  'invalid_key': 'The P7 gateway rejected the stored access key. Reconnect P7 from the company model settings page so a current key is stored.',
  'web_search_disabled': 'Desktop web search is switched off for this P7 account. Only a P7 administrator can enable it; nothing in DSH can.',
  'validation_failed': 'The P7 gateway rejected the search request. Retry with a shorter, non-blank query.',
  'web_search_upstream_unavailable': 'The P7 search upstream is temporarily unavailable. Retry shortly; the gateway, not DSH, holds that dependency.',
  'web_search_unavailable': 'This P7 deployment has no desktop web search wired up. Ask the P7 administrator to enable the search egress service.',
}

/** A stable code is the only failure detail this client repeats. */
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/

/**
 * Map one gateway result entry to a portable source.
 *
 * `url` is required and must be absolute http(s); an entry without one is
 * dropped rather than cited by title alone, and a missing `snippet` stays
 * missing — SearXNG excerpts are optional, and filling one in would make the
 * seam lie about what the upstream returned.
 * @param entry - one element of the gateway's `results[]`, untrusted.
 * @returns the normalized source, or `undefined` when it cannot be cited.
 */
export function mapP7Source(entry: unknown): WebSearchSource | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const url = optionalText(record.url) ?? ''
  if (!isCitableUrl(url)) return undefined
  const title = optionalText(record.title)
  const snippet = optionalText(record.snippet)
  const publishedAt = optionalText(record.publishedAt)
  return {
    url,
    ...title === undefined ? {} : { title },
    ...snippet === undefined ? {} : { snippet },
    ...publishedAt === undefined ? {} : { publishedAt },
  }
}

/**
 * Map the gateway's success envelope to a normalized search result.
 * @param payload - the parsed `POST /v1/desktop/web-search` body, untrusted.
 * @returns sources plus the gateway's own `truncated` flag; `content` is omitted
 *   because SearXNG returns no generated answer.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when the envelope is not an object
 *   or `results` is neither absent nor an array.
 */
export function mapP7Response(payload: unknown): WebSearchResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw unprocessable()
  const body = payload as { results?: unknown; truncated?: unknown }
  if (!Array.isArray(body.results)) throw unprocessable()
  const sources: WebSearchSource[] = []
  for (const entry of body.results) {
    const source = mapP7Source(entry)
    if (source !== undefined) sources.push(source)
  }
  return { sources, truncated: Boolean(body.truncated) }
}

/** The P7-backed search provider. HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class P7SearchProvider implements WebSearchProvider {
  readonly id = P7_PROVIDER_ID

  constructor(private readonly options: P7SearchProviderOptions) {}

  /**
   * Cheap local usability check: no network, no credential write, no catalog.
   * It is deliberately honest — the seam raises a hard
   * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` for a selected-but-unavailable
   * provider, so this must never claim readiness on a missing key, and this
   * plugin is not composed as the default provider.
   */
  available(): boolean {
    const connection = this.options.connection.peek()
    return isValidP7Origin(connection.origin)
      && (connection.apiKey.length > 0 || this.options.connection.hasPendingCredentialRefresh?.() === true)
      && isPositiveInteger(connection.requestTimeoutMs)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const connection = await this.resolveConnection(signal)
    const origin = normalizeP7Origin(connection.origin)
    if (origin === undefined) {
      throw new WebError(
        'P7 web search has no usable gateway origin; "origin" must be an HTTPS URL with no path, query, fragment, or embedded credentials',
        'WEB_PROVIDER_ERROR',
      )
    }
    if (connection.apiKey.length === 0) {
      throw new WebError(missingKeyMessage(this.options.credentialRef), 'WEB_PROVIDER_CREDENTIAL_MISSING')
    }
    throwIfAborted(signal)

    // One controller carries both the caller's cancellation and this request's
    // deadline, and the deadline stays armed through body reading — a gateway
    // that answers headers then stalls cannot hold the tool open forever.
    const controller = new AbortController()
    let timedOut = false
    const onAbort = (): void => { controller.abort() }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, connection.requestTimeoutMs)
    const halt = (error: unknown): WebError | undefined => {
      // A cancellation already classified deeper in the read is passed through
      // unchanged: the failure-body path catches, and swallowing the one error
      // that is not a provider fault would turn a cancel into a fake HTTP error.
      if (error instanceof WebError && error.code === 'WEB_ABORTED') return error
      if (signal?.aborted === true) return abortedError(signal, error)
      if (timedOut) return timeoutError()
      if (error instanceof DOMException && error.name === 'AbortError') return abortedError(signal, error)
      return undefined
    }
    try {
      const fetchImpl: P7Fetch = this.options.fetch ?? ((input, init) => globalThis.fetch(input, init))
      // `pageno` is a page number, so a request's `maxResults` is never sent as
      // one; the seam truncates the page it asked the caller to bound.
      const body: P7SearchRequestBody = { query: request.query }
      let response: Response
      try {
        response = await fetchImpl(`${origin}${P7_WEB_SEARCH_PATH}`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'accept': 'application/json',
            'authorization': `Bearer ${connection.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error: unknown) {
        throw halt(error) ?? new WebError('P7 web search could not reach the gateway', 'WEB_PROVIDER_ERROR', { cause: error })
      }

      if (!response.ok) throw await httpError(response, controller.signal, halt)
      const bytes = await readBoundedBody(response, P7_MAX_RESPONSE_BYTES, controller.signal, halt)
      throwIfAborted(signal)
      let payload: unknown
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes))
      } catch (error: unknown) {
        throw halt(error) ?? unprocessable()
      }
      return applyCeiling(mapP7Response(payload), connection.maxResults)
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  private async resolveConnection(signal?: AbortSignal): Promise<P7ResolvedConnection> {
    throwIfAborted(signal)
    try {
      return await this.options.connection.resolve()
    } catch (error: unknown) {
      if (signal?.aborted === true) throw abortedError(signal, error)
      throw new WebError('P7 web search could not read its gateway connection', 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/**
 * Turn a non-2xx gateway response into a {@link WebError} that carries the
 * machine code, and nothing else of the body. Both documented shapes are read:
 * `{"error":{"code",…}}` and FastAPI's own `{"detail":[…]}`, whose entries echo
 * submitted values and are therefore never repeated.
 */
async function httpError(
  response: Response, signal: AbortSignal, halt: (error: unknown) => WebError | undefined,
): Promise<WebError> {
  const status = response.status
  let code: string | undefined
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(await readBoundedBody(response, P7_MAX_ERROR_BODY_BYTES, signal, halt)))
    code = machineCode(payload)
  } catch (error: unknown) {
    const cancellation = halt(error)
    if (cancellation !== undefined) throw cancellation
    // Otherwise only the status is known. A gateway 5xx or an intermediate proxy
    // page is normally not JSON, and that costs a richer hint, never the error.
  }
  const base = `P7 web search failed (HTTP ${String(status)})`
  if (code === undefined) return new WebError(base, 'WEB_PROVIDER_ERROR')
  const hint = CODE_HINTS[code]
  return new WebError(`${base}: ${code}${hint === undefined ? '' : `\n\n${hint}`}`, 'WEB_PROVIDER_ERROR')
}

/** The documented code, when the body states one in a form safe to repeat. */
function machineCode(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as { error?: unknown; detail?: unknown }
  if (typeof body.error === 'string' && CODE_PATTERN.test(body.error)) return body.error
  const error = body.error
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && CODE_PATTERN.test(code)) return code
  }
  // FastAPI's 422 shape has no code field; its existence is the whole fact.
  if (Array.isArray(body.detail)) return 'validation_failed'
  return undefined
}

/** True when `url` can be cited: absolute, http(s), and with a hostname. */
function isCitableUrl(url: string): boolean {
  if (url.length === 0) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
}

/**
 * Read a response body under a byte ceiling, cancelling with the request. Copied
 * in behaviour from the tested P7 config client: an advertised `Content-Length`
 * over the limit is refused before the body is consumed, and a stream that
 * exceeds it mid-read is cancelled.
 */
async function readBoundedBody(
  response: Response, limit: number, signal: AbortSignal, halt: (error: unknown) => WebError | undefined,
): Promise<Uint8Array> {
  const advertised = response.headers.get('content-length')
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) throw bodyTooLarge()
  const reader = response.body?.getReader()
  if (reader === undefined) throw unprocessable('P7 web search returned a response with no readable body')
  const abort = (): void => { void reader.cancel() }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>
      try {
        next = await reader.read()
      } catch (error: unknown) {
        throw halt(error) ?? unprocessable('P7 web search response body could not be read')
      }
      if (next.done) break
      const chunk = next.value
      if (chunk === undefined) break
      total += chunk.byteLength
      if (total > limit) {
        await reader.cancel()
        throw bodyTooLarge()
      }
      chunks.push(chunk)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Honor the documented ceiling locally; it is never transmitted to the gateway. */
function applyCeiling(result: WebSearchResult, maxResults: number | undefined): WebSearchResult {
  if (maxResults === undefined || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

/** A string field when it carries text, `undefined` when absent, null, or blank. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? value : undefined
}

function missingKeyMessage(ref: string): string {
  return `P7 web search has no gateway access key for "${ref}". Connect P7 from the company model settings page, `
    + 'export that reference in the launching environment, or set a literal "apiKey" in the web-search-p7 config.'
}

function bodyTooLarge(): WebError {
  return new WebError(`P7 web search returned a response larger than ${String(P7_MAX_RESPONSE_BYTES)} bytes`, 'WEB_PROVIDER_ERROR')
}

function unprocessable(message = 'P7 web search returned an unprocessable response body'): WebError {
  return new WebError(message, 'WEB_PROVIDER_ERROR')
}

function timeoutError(): WebError {
  return new WebError('P7 web search timed out before the gateway answered', 'WEB_PROVIDER_ERROR')
}

function abortedError(signal: AbortSignal | undefined, fallback?: unknown): WebError {
  return new WebError('P7 web search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortedError(signal)
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
