import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as plugin from '../src/index.js'
import { p7CredentialRef, P7_DEFAULT_ORIGIN, P7ConnectionResolver, normalizeP7Origin } from '../src/connection.js'
import type { P7ResolvedConnection } from '../src/connection.js'
import { mapP7Response, mapP7Source, P7SearchProvider } from '../src/provider.js'
import type { P7Fetch } from '../src/provider.js'

const SECRET = 'p7k_never_echo_this_key_9f3a'
const REF = 'P7_DSH_TESTPROFILE_API_KEY'

function connection(overrides: Partial<P7ResolvedConnection> = {}): P7ResolvedConnection {
  return { origin: 'https://p7.test', apiKey: SECRET, requestTimeoutMs: 10_000, ...overrides }
}

function providerFor(conn: P7ResolvedConnection, fetch?: P7Fetch): P7SearchProvider {
  return new P7SearchProvider({
    connection: { peek: () => conn, resolve: async () => conn },
    credentialRef: REF,
    ...fetch === undefined ? {} : { fetch },
  })
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function okBody(...urls: string[]): unknown {
  return { schemaVersion: 1, requestId: 'req-1', results: urls.map(url => ({ url })), truncated: false }
}

/** Test double for the optional account service, with explicit login/logout notifications. */
class PersonalAccount {
  private token = ''
  private readonly listeners = new Set<() => void>()

  usesPersonalToken(): boolean { return true }
  async getValidAccessToken(): Promise<string> {
    if (!this.token) throw new Error('P7 personal sign-in is required.')
    return this.token
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  login(token: string): void { this.token = token; this.publish() }
  logout(): void { this.token = ''; this.publish() }
  get subscriberCount(): number { return this.listeners.size }
  private publish(): void { for (const listener of this.listeners) listener() }
}

/** A broker that explicitly permits the legacy shared credential plane. */
class SharedAccount {
  private readonly listeners = new Set<() => void>()

  usesPersonalToken(): boolean { return false }
  async getValidAccessToken(): Promise<string> { throw new Error('shared credentials do not use a personal token') }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  get subscriberCount(): number { return this.listeners.size }
}

/** The first (and only) call a fetch mock received. */
function singleCall(fetch: P7Fetch): [string, RequestInit] {
  const calls = vi.mocked(fetch).mock.calls
  expect(calls).toHaveLength(1)
  return calls[0] as [string, RequestInit]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('P7 source mapping', () => {
  it('keeps a url-only source', () => {
    expect(mapP7Source({ url: 'https://a.test/x' })).toEqual({ url: 'https://a.test/x' })
  })

  it('keeps a snippet-less source with its other fields', () => {
    expect(mapP7Source({ url: 'https://a.test', title: 'A', snippet: '', publishedAt: '2026-01-01' }))
      .toEqual({ url: 'https://a.test', title: 'A', publishedAt: '2026-01-01' })
    expect(mapP7Source({ url: 'https://a.test', title: null, snippet: null, publishedAt: null }))
      .toEqual({ url: 'https://a.test' })
  })

  it('keeps a plain http citation because the seam allows http(s)', () => {
    expect(mapP7Source({ url: 'http://a.test', snippet: 'text' })).toEqual({ url: 'http://a.test', snippet: 'text' })
  })

  it('drops an entry with no usable url', () => {
    expect(mapP7Source({ title: 'no url' })).toBeUndefined()
    expect(mapP7Source({ url: '', title: 'blank' })).toBeUndefined()
    expect(mapP7Source({ url: '   ' })).toBeUndefined()
    expect(mapP7Source('https://a.test')).toBeUndefined()
    expect(mapP7Source(null)).toBeUndefined()
  })

  it('drops a non-http url rather than inventing one', () => {
    for (const url of ['ftp://a.test', 'javascript:alert(1)', '//a.test', 'not a url', 'mailto:a@b.test']) {
      expect(mapP7Source({ url, snippet: 'text' })).toBeUndefined()
    }
  })

  it('maps a response to sources and the gateway truncation flag, with no content', () => {
    const result = mapP7Response({
      schemaVersion: 1,
      requestId: 'req-2',
      results: [
        { url: 'https://a.test', title: 'A', snippet: 'one' },
        { title: 'no url at all' },
        { url: 'ftp://b.test', snippet: 'two' },
        { url: 'https://c.test', publishedAt: '2026-02-02' },
      ],
      truncated: true,
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'one' },
        { url: 'https://c.test', publishedAt: '2026-02-02' },
      ],
      truncated: true,
    })
    expect(result.content).toBeUndefined()
  })

  it('rejects a success envelope without its required results array', () => {
    expect(() => mapP7Response({ schemaVersion: 1, requestId: 'req-3' }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('rejects a well-formed body of the wrong shape', () => {
    for (const payload of [null, 'text', [], { results: {} }] as unknown[]) {
      expect(() => mapP7Response(payload)).toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    }
  })
})

describe('P7 provider availability', () => {
  it('is unavailable without a key', () => {
    expect(providerFor(connection({ apiKey: '' })).available()).toBe(false)
  })

  it('is available with a key and an HTTPS origin', () => {
    expect(providerFor(connection()).available()).toBe(true)
  })

  it('is unavailable for an origin outside the contract', () => {
    for (const origin of ['http://p7.test', 'https://user@p7.test', 'https://p7.test/search', 'https://p7.test/?x=1', 'not a url']) {
      expect(providerFor(connection({ origin })).available()).toBe(false)
    }
  })

  it('is unavailable for a request timeout that is not a positive integer', () => {
    expect(providerFor(connection({ requestTimeoutMs: 0 })).available()).toBe(false)
    expect(providerFor(connection({ requestTimeoutMs: 1.5 })).available()).toBe(false)
  })

  it('performs no IO in the availability check', () => {
    const resolve = vi.fn(async () => connection())
    const peek = vi.fn(() => connection())
    const provider = new P7SearchProvider({ connection: { peek, resolve }, credentialRef: REF })
    expect(provider.available()).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe('P7 request shape', () => {
  it('posts the contract body to the gateway path with bearer authentication only in the header', async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody('https://a.test'))) as unknown as P7Fetch
    await providerFor(connection(), fetch).search({ query: 'p7 search' })
    const [url, init] = singleCall(fetch)
    expect(url).toBe('https://p7.test/v1/desktop/web-search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(init.headers).toMatchObject({ authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ query: 'p7 search' })
  })

  it('never sends pageno for a counted request, and lets the seam truncate', async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody('https://a.test', 'https://b.test'))) as unknown as P7Fetch
    const result = await providerFor(connection({ maxResults: 1 }), fetch).search({ query: 'q', maxResults: 2 })
    const [, init] = singleCall(fetch)
    expect(JSON.parse(init.body as string)).not.toHaveProperty('pageno')
    // The configured ceiling is applied locally, so the over-return is flagged.
    expect(result).toEqual({ sources: [{ url: 'https://a.test' }], truncated: true })
  })

  it('reports the gateway truncation flag and omits content', async () => {
    const fetch = vi.fn(async () => jsonResponse({ schemaVersion: 1, requestId: 'r', results: [{ url: 'https://a.test' }], truncated: true })) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .resolves.toEqual({ sources: [{ url: 'https://a.test' }], truncated: true })
  })

  it('cancels a dispatched request when the caller aborts', async () => {
    const controller = new AbortController()
    // The search resolves its connection before dispatch, so the abort is raised
    // only once the request is genuinely in flight.
    let dispatched!: (signal: AbortSignal) => void
    const dispatch = new Promise<AbortSignal>((resolve => { dispatched = resolve }))
    const fetch = vi.fn((_input: RequestInfo | URL, init: RequestInit) => {
      dispatched(init.signal as AbortSignal)
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
      })
    }) as unknown as P7Fetch
    const pending = providerFor(connection(), fetch).search({ query: 'q' }, controller.signal)
    const observedSignal = await dispatch
    controller.abort()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(observedSignal.aborted).toBe(true)
  })

  it('surfaces a request deadline as a provider failure, not as a cancellation', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn((_input: RequestInfo | URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
      })) as unknown as P7Fetch
      const pending = providerFor(connection({ requestTimeoutMs: 10 }), fetch).search({ query: 'q' })
      const asserted = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'P7 web search timed out before the gateway answered' }))
      await vi.advanceTimersByTimeAsync(10)
      await asserted
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P7 failure mapping', () => {
  it('carries the machine code of a documented failure body', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { code: 'web_search_disabled', message: 'Desktop web search is disabled' }, requestId: 'r' }, { status: 403 })) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('403') }))
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining('web_search_disabled') }))
  })

  it('tolerates FastAPI validation detail without repeating its contents', async () => {
    const echoed = 'a submitted value that must not be repeated'
    const fetch = vi.fn(async () => jsonResponse({ detail: [{ loc: ['body', 'query'], msg: 'query must not be blank', input: echoed }] }, { status: 422 })) as unknown as P7Fetch
    const thrown = await providerFor(connection(), fetch).search({ query: echoed }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as Error & { code?: string }
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('validation_failed')
    expect(error.message).not.toContain(echoed)
  })

  it('keeps a status-only message for a non-JSON failure body', async () => {
    const fetch = vi.fn(async () => new Response('upstream exploded', { status: 502 })) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'P7 web search failed (HTTP 502)' }))
  })

  it('maps a malformed success body to a provider error', async () => {
    const fetch = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'P7 web search returned an unprocessable response body' }))
  })

  it('rejects an advertised response over the byte ceiling before consuming it', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200, headers: { 'Content-Length': String(256 * 1024 + 1) } })) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('larger than') }))
  })

  it('cancels a streamed body as soon as it exceeds the ceiling', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // One chunk past the 256 KiB contract ceiling, so the cap is what stops the read.
        for (let index = 0; index < 65; index += 1) controller.enqueue(new Uint8Array(4096))
      },
      cancel() { cancelled = true },
    })
    const fetch = vi.fn(async () => new Response(body, { status: 200 })) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('larger than') }))
    expect(cancelled).toBe(true)
  })

  it('maps a transport failure to a provider error', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('connection refused') }) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    const fetch = vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an abort during a failure-body read to WEB_ABORTED', async () => {
    const reader = {
      read: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      cancel: () => Promise.resolve(),
      releaseLock: () => undefined,
    }
    const fetch = vi.fn(async () => ({
      ok: false, status: 500, headers: new Headers(), body: { getReader: () => reader },
    }) as unknown as Response) as unknown as P7Fetch
    await expect(providerFor(connection(), fetch).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('never throws before dispatch for an already-cancelled request', async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody())) as unknown as P7Fetch
    const controller = new AbortController()
    controller.abort()
    await expect(providerFor(connection(), fetch).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('secret containment', () => {
  const failures: readonly [string, () => Response][] = [
    ['401', () => new Response(JSON.stringify({ error: { code: 'invalid_key', message: 'Invalid Pro7 access key' }, requestId: 'r' }), { status: 401 })],
    ['403', () => new Response(JSON.stringify({ error: { code: 'web_search_disabled', message: 'disabled' }, requestId: 'r' }), { status: 403 })],
    ['422', () => new Response(JSON.stringify({ detail: [] }), { status: 422 })],
    ['502', () => new Response(JSON.stringify({ error: { code: 'web_search_upstream_unavailable', message: 'upstream' }, requestId: 'r' }), { status: 502 })],
    ['503', () => new Response(JSON.stringify({ error: { code: 'web_search_unavailable', message: 'unavailable' }, requestId: 'r' }), { status: 503 })],
    ['200 malformed', () => new Response('{', { status: 200 })],
    ['transport', () => { throw new TypeError(`fetch failed for https://p7.test with ${SECRET}`) }],
  ]
  const query = 'the raw query text'

  it.each(failures)('leaks neither the key nor the query through the %s path', async (_label, respond) => {
    const fetch = vi.fn(async () => respond()) as unknown as P7Fetch
    const thrown = await providerFor(connection(), fetch).search({ query }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as Error & { code?: string }
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    const text = `${error.message}\n${error.stack ?? ''}`
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(query)
  })

  it('names only the reference when no key resolved', async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody('https://a.test'))) as unknown as P7Fetch
    const thrown = await providerFor(connection({ apiKey: '' }), fetch).search({ query: 'q' }).catch((error: unknown) => error)
    const error = thrown as Error & { code?: string }
    expect(error.code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
    expect(error.message).toContain(REF)
    expect(error.message).not.toContain(SECRET)
  })

  it('sends the key in exactly one header', async () => {
    const fetch = vi.fn(async () => jsonResponse(okBody('https://a.test'))) as unknown as P7Fetch
    await providerFor(connection(), fetch).search({ query: 'q' })
    const [, init] = singleCall(fetch)
    const serialized = JSON.stringify({ url: 'x', ...init, headers: undefined })
    expect(serialized).not.toContain(SECRET)
    expect(init.headers).toMatchObject({ authorization: `Bearer ${SECRET}` })
  })
})

describe('P7 connection layers', () => {
  it('does not dispatch a token resolved before a newer personal-account invalidation', async () => {
    let personalMode = false
    let releaseToken!: (value: string) => void
    let tokenRequested!: () => void
    const token = new Promise<string>(resolve => { releaseToken = resolve })
    const requested = new Promise<void>(resolve => { tokenRequested = resolve })
    const resolver = new P7ConnectionResolver({
      credentialRef: REF as never,
      configuredOrigin: 'https://p7.test',
      configuredApiKey: 'shared-key',
      persistenceFile: 'missing',
      requestTimeoutMs: 1000,
      ambientApiKey: () => undefined,
      usesPersonalToken: () => personalMode,
      personalAccessToken: async () => { tokenRequested(); return await token },
    })
    await resolver.settling
    personalMode = true
    resolver.invalidate()
    const fetch = vi.fn(async () => jsonResponse(okBody('https://a.test'))) as unknown as P7Fetch
    const search = new P7SearchProvider({ connection: resolver, credentialRef: REF, fetch }).search({ query: 'stale personal token' })
    await requested
    // This is the account subscriber's logout/failure invalidation while the
    // previous token getter is still in flight.
    resolver.invalidate()
    releaseToken(SECRET)
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(resolver.peek().apiKey).toBe('')
  })

  it('derives the credential reference from the Profile id', () => {
    expect(p7CredentialRef('/profiles/main')).toMatch(/^P7_DSH_[0-9A-F]{24}_API_KEY$/)
    expect(p7CredentialRef('/profiles/main')).toBe(p7CredentialRef('/profiles/main'))
    expect(p7CredentialRef('/profiles/other')).not.toBe(p7CredentialRef('/profiles/main'))
  })

  it('normalizes only contract-safe origins', () => {
    expect(normalizeP7Origin('https://maas.zxrc.com.cn:8090')).toBe('https://maas.zxrc.com.cn:8090')
    expect(normalizeP7Origin('https://p7.test/')).toBe('https://p7.test')
    for (const unsafe of ['http://p7.test', 'https://p7.test:8090/search', 'https://u@p7.test', 'https://p7.test/?x=1', 'https://p7.test/#h', 'p7.test']) {
      expect(normalizeP7Origin(unsafe)).toBeUndefined()
    }
  })

  it('takes the origin from the Profile snapshot the company plugin owns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-'))
    try {
      await writeFile(join(dir, '.p7-company-models.json'), JSON.stringify({ version: 1, origin: 'https://snapshot.p7.test', ownedIds: [] }), 'utf8')
      const fetch = vi.fn(async () => jsonResponse(okBody('https://a.test'))) as unknown as P7Fetch
      const resolver = new PConnectionSnapshotProbe(dir)
      await expect(resolver.resolve()).resolves.toMatchObject({ origin: 'https://snapshot.p7.test' })
      await new P7SearchProvider({ connection: resolver, credentialRef: REF, fetch }).search({ query: 'q' })
      expect(singleCall(fetch)[0]).toBe('https://snapshot.p7.test/v1/desktop/web-search')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a snapshot it cannot use as no snapshot at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-'))
    try {
      await writeFile(join(dir, '.p7-company-models.json'), '{ not json', 'utf8')
      const resolver = new PConnectionSnapshotProbe(dir)
      await expect(resolver.resolve()).resolves.toMatchObject({ origin: P7_DEFAULT_ORIGIN, apiKey: 'probe-key' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lets a configured origin win over the snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-'))
    try {
      await writeFile(join(dir, '.p7-company-models.json'), JSON.stringify({ version: 1, origin: 'https://snapshot.p7.test' }), 'utf8')
      const resolver = new PConnectionSnapshotProbe(dir, { configuredOrigin: 'https://configured.p7.test' })
      await expect(resolver.resolve()).resolves.toMatchObject({ origin: 'https://configured.p7.test' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('follows the company snapshot when a reconnect changes the gateway origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-'))
    try {
      const persistence = join(dir, '.p7-company-models.json')
      await writeFile(persistence, JSON.stringify({ version: 1, origin: 'https://first.p7.test', ownedIds: [] }), 'utf8')
      const resolver = new PConnectionSnapshotProbe(dir)
      await expect(resolver.resolve()).resolves.toMatchObject({ origin: 'https://first.p7.test' })
      await writeFile(persistence, JSON.stringify({ version: 1, origin: 'https://second.p7.test', ownedIds: [] }), 'utf8')
      await resolver.refresh()
      await expect(resolver.resolve()).resolves.toMatchObject({ origin: 'https://second.p7.test' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps a configured invalid origin visible rather than defaulting', async () => {
    const resolver = new PConnectionSnapshotProbe('' , { configuredOrigin: 'http://insecure.p7.test' })
    await expect(resolver.resolve()).resolves.toMatchObject({ origin: 'http://insecure.p7.test' })
    expect(new P7SearchProvider({ connection: resolver, credentialRef: REF }).available()).toBe(false)
  })

  it('resolves the key from the credential plane before the environment, and re-reads it per operation', async () => {
    const resolve = vi.fn(async () => ({ value: 'stored-key', source: 'file' }))
    const resolver = new P7ConnectionResolver({
      credentialRef: REF as never,
      credentials: { resolve },
      persistenceFile: join('no-such-profile-dir', '.p7-company-models.json'),
      ambientApiKey: () => 'ambient-key',
      requestTimeoutMs: 10_000,
    })
    // Before the credential plane has been read, the cheap synchronous view is the
    // environment layer; the stored value wins as soon as the read lands.
    expect(resolver.peek().apiKey).toBe('ambient-key')
    await expect(resolver.resolve()).resolves.toMatchObject({ apiKey: 'stored-key' })
    expect(resolve).toHaveBeenCalledWith(REF)
    expect(resolver.peek().apiKey).toBe('stored-key')
    const fetch = vi.fn(async () => jsonResponse(okBody('https://a.test'))) as unknown as P7Fetch
    const readsBefore = vi.mocked(resolve).mock.calls.length
    await new P7SearchProvider({ connection: resolver, credentialRef: REF, fetch }).search({ query: 'q' })
    expect(singleCall(fetch)[1].headers).toMatchObject({ authorization: 'Bearer stored-key' })
    // One further read for this operation: the credential plane is consulted per
    // search, so a key P7 rotates reaches the next search without a remount.
    expect(vi.mocked(resolve).mock.calls.length).toBe(readsBefore + 1)
  })

  it('treats a blank key as no key in every layer', async () => {
    const resolver = new P7ConnectionResolver({
      credentialRef: REF as never,
      configuredApiKey: '   ',
      credentials: { resolve: async () => ({ value: '', source: 'file' }) },
      persistenceFile: join('no-such-profile-dir', '.p7-company-models.json'),
      ambientApiKey: () => '  ',
      requestTimeoutMs: 10_000,
    })
    await expect(resolver.resolve()).resolves.toMatchObject({ apiKey: '' })
    expect(new P7SearchProvider({ connection: resolver, credentialRef: REF }).available()).toBe(false)
  })

  it('falls back to the launch environment when the credential plane holds nothing', async () => {
    const resolver = new P7ConnectionResolver({
      credentialRef: REF as never,
      credentials: { resolve: async () => undefined },
      persistenceFile: join('no-such-profile-dir', '.p7-company-models.json'),
      ambientApiKey: () => 'ambient-key',
      requestTimeoutMs: 10_000,
    })
    await expect(resolver.resolve()).resolves.toMatchObject({ apiKey: 'ambient-key' })
    expect(resolver.peek().apiKey).toBe('ambient-key')
  })
})

describe('web-search-p7 plugin registration', () => {
  interface CredentialPlane { resolve: (ref: string) => Promise<{ value: string; source: string } | undefined> }

  async function mount(config: plugin.Config, credentials: CredentialPlane = { resolve: async () => undefined }): Promise<{ ctx: Context; dir: string; dispose: () => Promise<void> }> {
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-plugin-'))
    const ctx = new Context()
    ctx.provide('credentials', credentials as never)
    ctx.provide('profileContext', { dir } as never)
    await ctx.plugin(WebRuntime, { searchProvider: 'p7' })
    const fiber = await ctx.plugin(plugin, config)
    return { ctx, dir, dispose: async () => { await fiber.dispose() } }
  }

  it('registers under the id p7 and serves a search through ctx.web', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => jsonResponse(okBody('https://a.test', 'ftp://b.test')))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, dir, dispose } = await mount({ origin: 'https://p7.test', apiKey: SECRET })
    try {
      await expect(ctx.web.search({ query: 'q', maxResults: 5 })).resolves.toMatchObject({ sources: [{ url: 'https://a.test' }], truncated: false })
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://p7.test/v1/desktop/web-search')
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves the profile-derived reference through the credential service', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-plugin-'))
    try {
      const resolve = vi.fn(async () => ({ value: 'stored-key', source: 'file' }))
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => jsonResponse(okBody('https://a.test')))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      ctx.provide('credentials', { resolve } as never)
      ctx.provide('profileContext', { dir } as never)
      await ctx.plugin(WebRuntime, { searchProvider: 'p7' })
      const fiber = await ctx.plugin(plugin, { origin: 'https://p7.test' })
      await ctx.web.search({ query: 'q' })
      expect(resolve).toHaveBeenCalledWith(p7CredentialRef(dir))
      expect(vi.mocked(fetchMock).mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer stored-key' }) })
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serves the first selected search after the company credential commit', async () => {
    let stored = ''
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-plugin-'))
    try {
      const fetchMock = vi.fn(async () => jsonResponse(okBody('https://a.test')))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      ctx.provide('credentials', {
        resolve: async () => stored.length === 0 ? undefined : { value: stored, source: 'file' },
      } as never)
      ctx.provide('profileContext', { dir } as never)
      await ctx.plugin(WebRuntime, { searchProvider: 'p7' })
      const fiber = await ctx.plugin(plugin, { origin: 'https://p7.test' })
      try {
        // This is the notification emitted by CompanyHost's awaited
        // credentials.set(), which runs only after loader startup.
        stored = SECRET
        ctx.emit('credentials/reference-updated', p7CredentialRef(dir) as never)
        await expect(ctx.web.search({ query: 'first company search' })).resolves.toMatchObject({
          sources: [{ url: 'https://a.test' }],
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
      } finally { await fiber.dispose() }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('waits for the initial credential read instead of rejecting the selected provider', async () => {
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-plugin-'))
    try {
      const fetchMock = vi.fn(async () => jsonResponse(okBody('https://a.test')))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      ctx.provide('credentials', { resolve: async () => { await delayed; return { value: SECRET, source: 'file' } } } as never)
      ctx.provide('profileContext', { dir } as never)
      await ctx.plugin(WebRuntime, { searchProvider: 'p7' })
      const fiber = await ctx.plugin(plugin, { origin: 'https://p7.test' })
      try {
        const search = ctx.web.search({ query: 'startup credential wait' })
        release()
        await expect(search).resolves.toMatchObject({ sources: [{ url: 'https://a.test' }] })
      } finally { await fiber.dispose() }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('is registered but unavailable when no layer supplies a key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => jsonResponse(okBody('https://a.test')))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, dir, dispose } = await mount({ origin: 'https://p7.test' })
    try {
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tracks a late personal broker through login and logout without using a shared key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p7-web-search-plugin-'))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => jsonResponse(okBody('https://a.test')))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    const account = new PersonalAccount()
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    ctx.provide('profileContext', { dir } as never)
    await ctx.plugin(WebRuntime, { searchProvider: 'p7' })
    const fiber = await ctx.plugin(plugin, { origin: 'https://p7.test', apiKey: 'shared-key' })
    const removeAccount = ctx.provide('p7Account', account as never)
    let removeSharedAccount: (() => void) | undefined
    try {
      await vi.waitFor(() => { expect(account.subscriberCount).toBe(1) })
      await expect(ctx.web.search({ query: 'before personal login' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
      expect(fetchMock).not.toHaveBeenCalled()

      account.login(SECRET)
      await vi.waitFor(async () => {
        await expect(ctx.web.search({ query: 'after personal login' }))
          .resolves.toMatchObject({ sources: [{ url: 'https://a.test' }] })
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: `Bearer ${SECRET}` }) })

      account.logout()
      await expect(ctx.web.search({ query: 'after personal logout' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await removeAccount()
      await vi.waitFor(async () => {
        await expect(ctx.web.search({ query: 'after personal broker removal' }))
          .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const sharedAccount = new SharedAccount()
      removeSharedAccount = ctx.provide('p7Account', sharedAccount as never)
      await vi.waitFor(() => { expect(sharedAccount.subscriberCount).toBe(1) })
      await expect(ctx.web.search({ query: 'after shared mode is explicitly restored' }))
        .resolves.toMatchObject({ sources: [{ url: 'https://a.test' }] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer shared-key' }) })
    } finally {
      await fiber.dispose()
      if (removeSharedAccount) await removeSharedAccount()
      else await removeAccount()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the documented default origin when no layer names one', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => jsonResponse(okBody()))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, dir, dispose } = await mount({ apiKey: SECRET })
    try {
      await ctx.web.search({ query: 'q' })
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${P7_DEFAULT_ORIGIN}/v1/desktop/web-search`)
    } finally {
      await dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in plugin).toBe(false)
  })

  it('declares the seam and the two connection planes it injects', () => {
    expect(plugin.name).toBe('web-search-p7')
    expect(plugin.inject).toEqual(['web', 'credentials', 'profileContext'])
  })
})

/** A resolver pointed at one Profile directory, with the probe key as its literal layer. */
class PConnectionSnapshotProbe extends P7ConnectionResolver {
  constructor(dir: string, extra: { configuredOrigin?: string } = {}) {
    super({
      credentialRef: REF as never,
      configuredApiKey: 'probe-key',
      persistenceFile: dir.length === 0 ? '.p7-company-models.json' : join(dir, '.p7-company-models.json'),
      ambientApiKey: () => undefined,
      requestTimeoutMs: 10_000,
      ...extra,
    })
  }
}
