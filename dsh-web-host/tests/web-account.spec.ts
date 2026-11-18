import { describe, expect, it, vi } from 'vitest'
import { parsePrivateWebAccount, readPrivateWebAccount, WebAccountBroker } from '../src/web-account.js'
import { controllerPeerAllowed } from '../src/controller-route.js'

const profile = { userId: 'u', organizationId: 'o', displayName: 'User', role: 'member', deviceId: 'd', sessionId: 's', scopes: ['models'] }
const account = (expiresAt = Date.now() + 120_000) => ({ origin: 'https://maas.zxrc.com.cn:8090', instanceToken: 'p7wi_instance', expiresAt, tokenType: 'Bearer' as const, profile })

describe('Web account broker', () => {
  it('reads usage through the separate Web identity endpoint', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }))
    try {
      const broker = new WebAccountBroker({ publicOrigin: 'https://maas.zxrc.com.cn:8090' }, async () => account())
      await broker.restore()
      await broker.usage('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')
      expect(String(request.mock.calls[0]?.[0])).toContain('/api/v1/web-auth/usage?')
      expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer p7wi_instance' })
    } finally { request.mockRestore() }
  })
  it('requires the controller account mount instead of accepting an arbitrary bootstrap file', async () => {
    await expect(readPrivateWebAccount('/tmp/account.json', 'https://maas.zxrc.com.cn:8090')).rejects.toThrow('controller-owned mount')
  })

  it('uses only the controller-issued instance credential and never exposes it in status', async () => {
    const broker = new WebAccountBroker({ publicOrigin: 'https://maas.zxrc.com.cn:8090' }, async () => account())
    await broker.restore()
    await expect(broker.getValidAccessToken()).resolves.toBe('p7wi_instance')
    expect(JSON.stringify(broker.status())).not.toContain('p7wi_instance')
  })

  it('never starts a browser callback and clears only local state on logout', async () => {
    const broker = new WebAccountBroker({ publicOrigin: 'https://maas.zxrc.com.cn:8090' }, async () => account())
    await broker.restore(); await expect(broker.login()).resolves.toMatchObject({ phase: 'signed-in', authorizationUrl: null })
    await broker.logout()
    expect(broker.status()).toMatchObject({ phase: 'signed-out', profile: null })
  })

  it('fails closed when the controller credential is near expiry', async () => {
    const broker = new WebAccountBroker({ publicOrigin: 'https://maas.zxrc.com.cn:8090' }, async () => account(Date.now() + 1))
    await broker.restore()
    await expect(broker.getValidAccessToken()).rejects.toThrow('expired')
    expect(broker.status().phase).toBe('expired')
  })

  it('publishes a failed controller credential state only when it changes', async () => {
    let current: ReturnType<typeof account> | undefined = account()
    const broker = new WebAccountBroker({ publicOrigin: current.origin }, async () => current)
    await broker.restore()
    const onStatus = vi.fn()
    broker.subscribe(onStatus)

    current = account(Date.now())
    await expect(broker.getValidAccessToken()).rejects.toThrow('expired')
    await expect(broker.getValidAccessToken()).rejects.toThrow('expired')
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phase: 'expired', profile: null }))

    current = undefined
    await expect(broker.getValidAccessToken()).rejects.toThrow('sign-in is required')
    await expect(broker.getValidAccessToken()).rejects.toThrow('sign-in is required')
    expect(onStatus).toHaveBeenCalledTimes(2)
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'expired', message: 'The controller account is unavailable.' }))
  })

  it('accepts the real BFF instance.json shape and reloads rotated workload tokens', async () => {
    let current: unknown = {
      origin: 'https://maas.zxrc.com.cn:8090', accessToken: 'p7wi_first', expiresAt: new Date(Date.now() + 120_000).toISOString(), tokenType: 'Bearer',
      instanceId: 'web-1', generation: 1, audience: 'web',
      profile: { userId: 'u', organizationId: 'o', displayName: 'User', role: 'member', deviceId: null, sessionId: 's', scopes: ['models'] },
    }
    const load = async () => parsePrivateWebAccount(current, 'https://maas.zxrc.com.cn:8090')
    const broker = new WebAccountBroker({ publicOrigin: 'https://maas.zxrc.com.cn:8090' }, load)
    await broker.restore()
    expect(broker.status().profile?.deviceId).toBe('web-browser')
    await expect(broker.getValidAccessToken()).resolves.toBe('p7wi_first')
    current = { ...(current as Record<string, unknown>), accessToken: 'p7wi_second', profile: { ...(current as { profile: Record<string, unknown> }).profile, sessionId: 'new-parent-web-session' } }
    await expect(broker.getValidAccessToken()).resolves.toBe('p7wi_second')
    current = { ...(current as Record<string, unknown>), profile: { ...(current as { profile: Record<string, unknown> }).profile, userId: 'other-user' } }
    await expect(broker.getValidAccessToken()).rejects.toThrow('sign-in is required')
    current = { ...(current as Record<string, unknown>), profile: { ...(current as { profile: Record<string, unknown> }).profile, userId: 'u' }, expiresAt: new Date(Date.now() - 1_000).toISOString() }
    await expect(broker.getValidAccessToken()).rejects.toThrow('expired')
    expect(broker.status().phase).toBe('expired')
  })
})

describe('controller network admission', () => {
  it('permits only the configured exact controller peer', () => {
    expect(controllerPeerAllowed('172.18.0.1', '172.18.0.1')).toBe(true)
    expect(controllerPeerAllowed('172.18.0.2', '172.18.0.1')).toBe(false)
    expect(controllerPeerAllowed('10.0.0.4', '10.0.0.0/8')).toBe(false)
  })
})
