import { describe, expect, it, vi } from 'vitest'
import { AccountBroker } from '../src/account-broker.js'

const profile = { userId: 'u1', organizationId: 'o1', displayName: 'Ada', role: 'employee', deviceId: 'd1', sessionId: 's1', scopes: ['model:use'] }
const token = (accessToken: string, refreshToken = 'refresh-1') => ({ accessToken, refreshToken, expiresAt: Date.now() + 120_000, tokenType: 'Bearer', profile })

describe('AccountBroker', () => {
  it('keeps the personal-token resolver mandatory when the company profile requires login', async () => {
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'required-profile', requirePersonalLogin: true })
    try {
      broker.setPersonalMode(false)
      expect(broker.usesPersonalToken()).toBe(true)
      expect(broker.connection().usesPersonalToken()).toBe(true)
      await expect(broker.connection().getValidAccessToken()).rejects.toThrow('sign-in is required')
    } finally { await broker.dispose() }
  })
  it('accepts the actual P7 ISO timestamp response shape for login and tokens', async () => {
    let start: Record<string, unknown> | undefined
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'iso-profile', openBrowser: () => {}, fetch: async (input, init) => {
      if (String(input).endsWith('/login-transactions')) { start = JSON.parse(String(init?.body)); return Response.json({ transactionId: 'tx', pollToken: 'poll', authorizationUrl: 'https://identity.example/authorize', expiresAt: new Date(Date.now() + 60000).toISOString() }) }
      return Response.json({ ...token('p7d_iso-test'), expiresAt: new Date(Date.now() + 120000).toISOString() })
    } })
    try {
      await broker.login()
      await globalThis.fetch(`${String(start?.redirectUri)}?transactionId=tx&state=${String(start?.state)}`)
      await vi.waitFor(() => expect(broker.status().phase).toBe('signed-in'))
      await expect(broker.getValidAccessToken()).resolves.toBe('p7d_iso-test')
    } finally { await broker.dispose() }
  })

  it('cannot revive a pending login that finishes after logout', async () => {
    let resolve!: (response: Response) => void
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'late-profile', openBrowser: vi.fn(), fetch: async () => await new Promise<Response>(done => { resolve = done }) })
    const login = broker.login()
    const completed = expect(login).resolves.toMatchObject({ phase: 'signed-out' })
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await broker.logout()
    resolve(Response.json({ transactionId: 'tx', pollToken: 'poll', authorizationUrl: 'https://identity.example/authorize', expiresAt: new Date(Date.now() + 60000).toISOString() }))
    await completed
    expect(broker.status().phase).toBe('signed-out')
    await broker.dispose()
  })
  it('rejects a callback with the wrong transaction id or state and leaves the transaction pending', async () => {
    let start: Record<string, unknown> | undefined
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'profile', openBrowser: () => {}, fetch: async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/policy')) return Response.json({ upgradeRequired: false })
      start = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ transactionId: 'tx', pollToken: 'poll', authorizationUrl: 'https://identity.example/authorize', expiresAt: Date.now() + 60_000 }))
    } })
    await broker.login(); const wrongTransaction = await globalThis.fetch(`${String(start?.redirectUri)}?transactionId=other&state=${String(start?.state)}`)
    expect(wrongTransaction.status).toBe(400); expect(broker.status().phase).toBe('pending')
    const wrongState = await globalThis.fetch(`${String(start?.redirectUri)}?transactionId=tx&state=wrong`)
    expect(wrongState.status).toBe(400); expect(broker.status().phase).toBe('pending'); await broker.dispose()
  })

  it('serializes concurrent refreshes and never exposes tokens in public status', async () => {
    let start: Record<string, unknown> | undefined; let refreshes = 0
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/login-transactions')) { start = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ transactionId: 'tx', pollToken: 'poll', authorizationUrl: 'https://identity.example/authorize', expiresAt: Date.now() + 60_000 })) }
      if (path.endsWith('/token')) return new Response(JSON.stringify({ ...token('access-1'), expiresAt: Date.now() + 1 }))
      if (path.endsWith('/token/refresh')) { refreshes++; return new Response(JSON.stringify(token('access-2', 'refresh-2'))) }
      return new Response('{}')
    }) as unknown as typeof globalThis.fetch
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'profile', openBrowser: () => {}, fetch })
    await broker.login(); await globalThis.fetch(`${String(start?.redirectUri)}?transactionId=tx&state=${String(start?.state)}`); await vi.waitFor(() => expect(broker.status().phase).toBe('signed-in'))
    await Promise.all([broker.getValidAccessToken(), broker.getValidAccessToken(), broker.getValidAccessToken()])
    expect(refreshes).toBe(1); expect(JSON.stringify(broker.status())).not.toContain('access-2'); expect(JSON.stringify(broker.status())).not.toContain('refresh-2'); await broker.dispose()
  })

  it('renews the same account silently, retains it through a temporary outage, and notifies on expiry', async () => {
    let now = Date.now()
    let result: 'ok' | 'offline' | 'expired' = 'ok'
    const store = { load: vi.fn(async () => 'refresh-old'), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) }
    const openBrowser = vi.fn()
    const changed = vi.fn()
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'silent-renewal', requirePersonalLogin: true, store, openBrowser, now: () => now, fetch: async input => {
      if (String(input).includes('/policy')) return Response.json({ upgradeRequired: false })
      if (result === 'offline') throw new TypeError('offline')
      if (result === 'expired') return Response.json({ detail: 'expired' }, { status: 401 })
      return Response.json({ ...token('access-renewed'), expiresAt: now + 120_000 })
    } })
    const unsubscribe = broker.subscribe(changed)
    try {
      await broker.restore()
      expect(changed).toHaveBeenCalledOnce()
      changed.mockClear()
      now += 70_000
      await expect(broker.getValidAccessToken()).resolves.toBe('access-renewed')
      expect(changed).not.toHaveBeenCalled()
      expect(store.save).toHaveBeenCalledTimes(2)

      now += 70_000
      result = 'offline'
      await expect(broker.getValidAccessToken()).rejects.toThrow('offline')
      expect(broker.status()).toMatchObject({ phase: 'signed-in', profile, message: expect.stringContaining('retried') })
      expect(store.clear).not.toHaveBeenCalled()

      result = 'ok'
      changed.mockClear()
      await expect(broker.getValidAccessToken()).resolves.toBe('access-renewed')
      expect(changed).not.toHaveBeenCalled()
      expect(broker.status().message).toBeNull()
      now += 70_000
      result = 'expired'
      await expect(broker.getValidAccessToken()).rejects.toThrow()
      expect(broker.status()).toMatchObject({ phase: 'expired', profile: null })
      expect(changed).toHaveBeenCalledOnce()
      expect(store.clear).toHaveBeenCalledWith('https://p7.example')
      expect(openBrowser).not.toHaveBeenCalled()
    } finally { unsubscribe(); await broker.dispose() }
  })

  it('clears its in-memory session on logout and revokes the current bearer session', async () => {
    let start: Record<string, unknown> | undefined; const revocations: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/login-transactions')) { start = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify({ transactionId: 'tx', pollToken: 'poll', authorizationUrl: 'https://identity.example/authorize', expiresAt: Date.now() + 60_000 })) }
      if (path.endsWith('/token')) return new Response(JSON.stringify(token('access-secret', 'refresh-secret')))
      if (path.endsWith('/session/revoke')) { revocations.push(String((init?.headers as Record<string, string>).authorization)); return new Response(JSON.stringify({ revoked: true })) }
      return new Response('{}')
    }) as unknown as typeof globalThis.fetch
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'profile', openBrowser: () => {}, fetch })
    await broker.login(); await globalThis.fetch(`${String(start?.redirectUri)}?transactionId=tx&state=${String(start?.state)}`); await vi.waitFor(() => expect(broker.status().phase).toBe('signed-in'))
    await broker.logout(); expect(revocations).toEqual(['Bearer access-secret']); expect(broker.status()).toMatchObject({ phase: 'signed-out', profile: null }); await expect(broker.getValidAccessToken()).rejects.toThrow('sign-in is required')
    expect(broker.usesPersonalToken()).toBe(true)
  })

  it('restores a persisted refresh token, rotates it, and never saves an access token', async () => {
    const saves: string[] = []
    const store = { load: vi.fn(async () => 'refresh-old'), save: vi.fn(async (_origin: string, refresh: string) => { saves.push(refresh) }), clear: vi.fn(async () => {}) }
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'restored-profile', store, fetch: async (input, init) => {
      if (String(input).includes('/policy')) return Response.json({ upgradeRequired: false })
      expect(String(input)).toContain('/token/refresh')
      expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh-old' })
      return Response.json(token('p7d_fresh-access', 'refresh-rotated'))
    } })
    broker.setPersonalMode(true)
    await broker.restore()
    expect(broker.status().phase).toBe('signed-in')
    expect(saves).toEqual(['refresh-rotated'])
    expect(JSON.stringify(saves)).not.toContain('p7d_fresh-access')
    await broker.dispose()
  })

  it('does not resurrect or save a delayed restore after logout', async () => {
    let complete!: (response: Response) => void
    const store = { load: vi.fn(async () => 'refresh-old'), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) }
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'restore-race', store, fetch: async () => await new Promise<Response>(resolve => { complete = resolve }) })
    broker.setPersonalMode(true)
    const restoring = broker.restore()
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    await broker.logout()
    complete(Response.json(token('p7d_late', 'refresh-late')))
    await restoring
    expect(broker.status().phase).toBe('signed-out')
    expect(store.save).not.toHaveBeenCalled()
    expect(store.clear).toHaveBeenCalledWith('https://p7.example')
    await broker.dispose()
  })

  it('clears a refresh token after a delayed store save completes during logout', async () => {
    let releaseSave!: () => void
    const events: string[] = []
    const store = {
      load: vi.fn(async () => 'refresh-old'),
      save: vi.fn(async () => await new Promise<void>(resolve => { events.push('save'); releaseSave = resolve })),
      clear: vi.fn(async () => { events.push('clear') }),
    }
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'delayed-store-save', store, fetch: async input => {
      if (String(input).includes('/policy')) return Response.json({ upgradeRequired: false })
      return Response.json(token('access-new', 'refresh-new'))
    } })
    broker.setPersonalMode(true)
    const restoring = broker.restore()
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledWith('https://p7.example', 'refresh-new'))
    const loggingOut = broker.logout()
    releaseSave()
    await Promise.all([restoring, loggingOut])
    expect(events).toEqual(['save', 'clear'])
    expect(broker.status().phase).toBe('signed-out')
    await broker.dispose()
  })

  it('singleflights restore and retains the refresh token after a transient refresh failure', async () => {
    let refreshes = 0
    const store = { load: vi.fn(async () => 'refresh-old'), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) }
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'restore-singleflight', store, fetch: async input => {
      if (String(input).includes('/policy')) return Response.json({ upgradeRequired: false })
      refreshes++
      throw new TypeError('network offline')
    } })
    broker.setPersonalMode(true)
    await Promise.all([broker.restore(), broker.restore()])
    expect(refreshes).toBe(1)
    expect(store.clear).not.toHaveBeenCalled()
    expect(broker.status()).toMatchObject({ phase: 'error', message: expect.stringContaining('retried') })
    await broker.dispose()
  })

  it('does not let an asynchronous policy check revive state after logout', async () => {
    let completePolicy!: (response: Response) => void
    const store = { load: vi.fn(async () => 'refresh-old'), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) }
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'restore-policy-race', store, fetch: async input => {
      if (String(input).includes('/policy')) return await new Promise<Response>(resolve => { completePolicy = resolve })
      return Response.json(token('late-access', 'late-refresh'))
    } })
    broker.setPersonalMode(true)
    const restoring = broker.restore()
    await vi.waitFor(() => expect(completePolicy).toBeTypeOf('function'))
    await broker.logout()
    completePolicy(Response.json({ upgradeRequired: true, message: 'Update required', upgradeUrl: 'https://downloads.example/dsh' }))
    await restoring
    expect(broker.status()).toMatchObject({ phase: 'signed-out', upgradeUrl: null })
    expect(store.load).not.toHaveBeenCalled()
    expect(store.clear).toHaveBeenCalledWith('https://p7.example')
    await broker.dispose()
  })

  it('surfaces a 426 download URL while retaining the refresh token for upgrade', async () => {
    const store = { load: vi.fn(async () => 'refresh-old'), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) }
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'restore-upgrade', store, fetch: async () => Response.json({ detail: 'Install DSH 2.1' }, { status: 426, headers: { 'X-P7-Minimum-Desktop-Version': '2.1.0', 'X-P7-Upgrade-Url': 'https://downloads.example/dsh' } }) })
    broker.setPersonalMode(true)
    await broker.restore()
    expect(broker.status()).toMatchObject({ phase: 'upgrade-required', message: 'Install DSH 2.1', upgradeUrl: 'https://downloads.example/dsh' })
    expect(store.load).not.toHaveBeenCalled()
    expect(store.clear).not.toHaveBeenCalled()
    await broker.dispose()
  })

  it('keeps startup nonfatal when the OS-backed refresh store cannot be read', async () => {
    const store = { load: vi.fn(async () => { throw new Error('vault unavailable') }), save: vi.fn(async () => {}), clear: vi.fn(async () => {}) }
    const fetch = vi.fn(async () => Response.json({ upgradeRequired: false }))
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'vault-read-error', store, fetch })
    broker.setPersonalMode(true)
    await expect(broker.restore()).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.clear).not.toHaveBeenCalled()
    expect(broker.status()).toMatchObject({ phase: 'error', message: expect.stringContaining('restored') })
    await broker.dispose()
  })

  it('does not create a login transaction after the selected origin changes', async () => {
    let origin = 'https://p7.example'
    let completeTransaction!: (response: Response) => void
    const openBrowser = vi.fn()
    const broker = new AccountBroker({ origin: () => origin, profileId: 'login-origin-race', openBrowser, fetch: async input => {
      if (String(input).includes('/policy')) return Response.json({ upgradeRequired: false })
      return await new Promise<Response>(resolve => { completeTransaction = resolve })
    } })
    const login = broker.login()
    await vi.waitFor(() => expect(completeTransaction).toBeTypeOf('function'))
    origin = 'https://other.example'
    completeTransaction(Response.json({ transactionId: 'tx', pollToken: 'poll', authorizationUrl: 'https://identity.example/authorize', expiresAt: Date.now() + 60_000 }))
    await expect(login).rejects.toThrow('session changed')
    expect(openBrowser).not.toHaveBeenCalled()
    expect(broker.status().authorizationUrl).toBeNull()
    await broker.dispose()
  })

  it('stops before opening the browser when the minimum desktop version is required', async () => {
    const openBrowser = vi.fn()
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'upgrade-required', openBrowser, fetch: async input => {
      expect(String(input)).toContain('/desktop-auth/policy?')
      return Response.json({ minimumVersion: '2.1.0', clientVersion: '2.0.18-beta.15', upgradeRequired: true, upgradeUrl: 'https://downloads.example/dsh', message: 'Update required.' })
    } })
    await expect(broker.login()).resolves.toMatchObject({ phase: 'upgrade-required', upgradeUrl: 'https://downloads.example/dsh' })
    expect(openBrowser).not.toHaveBeenCalled()
    await broker.dispose()
  })
  it('does not expose a restored session if saving the rotated refresh credential fails', async () => {
    const store = { load: vi.fn(async () => 'refresh-old'), save: vi.fn(async () => { throw new Error('vault write failed') }), clear: vi.fn(async () => {}) }
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'vault-write-error', store,
      fetch: async input => String(input).includes('/policy') ? Response.json({ upgradeRequired: false }) : Response.json(token('p7d_unsaved', 'refresh-new')) })
    broker.setPersonalMode(true)
    try {
      await broker.restore()
      expect(broker.status()).toMatchObject({ phase: 'error', profile: null })
      await expect(broker.getValidAccessToken()).rejects.toThrow('sign-in is required')
    } finally { await broker.dispose() }
  })

})
