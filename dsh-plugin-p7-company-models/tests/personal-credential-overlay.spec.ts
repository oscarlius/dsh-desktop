import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import { AccountBroker } from '../src/account-broker.js'
import { installPersonalCredentialOverlay } from '../src/personal-credential-overlay.js'

describe('personal credential overlay', () => {
  it('decorates only the P7 reference, never stores a token, and restores safely', async () => {
    const ctx = new Context()
    const ref = credentialRef('P7_PROFILE_API_KEY'); const other = credentialRef('OTHER_API_KEY')
    const resolve = vi.fn(async (value: typeof ref) => ({ value: value === ref ? 'legacy-key' : 'other-key', source: 'file' }))
    const credentials = { resolve, set: vi.fn(), unset: vi.fn() }
    ctx.provide('credentials', credentials as never)
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'overlay', openBrowser: () => {} })
    broker.setPersonalMode(true)
    ;(broker as unknown as { getValidAccessToken: () => Promise<string> }).getValidAccessToken = async () => 'personal-token'
    const remove = installPersonalCredentialOverlay(ctx.credentials, ref, broker)
    await expect(ctx.credentials.resolve(ref)).resolves.toEqual({ value: 'personal-token', source: 'p7-session' })
    await expect(ctx.credentials.resolve(other)).resolves.toEqual({ value: 'other-key', source: 'file' })
    expect(credentials.set).not.toHaveBeenCalled(); expect(credentials.unset).not.toHaveBeenCalled()
    remove(); await expect(ctx.credentials.resolve(ref)).resolves.toEqual({ value: 'legacy-key', source: 'file' })
    await broker.dispose()
  })

  it('becomes transparent if a later resolver wrapper is still installed', async () => {
    const ref = credentialRef('P7_PROFILE_API_KEY'); const base = vi.fn(async (_candidate: typeof ref) => ({ value: 'legacy', source: 'file' }))
    const credentials = { resolve: base }
    const broker = new AccountBroker({ origin: () => 'https://p7.example', profileId: 'overlay-later', openBrowser: () => {} })
    const remove = installPersonalCredentialOverlay(credentials as never, ref, broker)
    const previous = credentials.resolve; const later = vi.fn(async (candidate: typeof ref) => await previous(candidate)); credentials.resolve = later
    remove(); await expect(credentials.resolve(ref)).resolves.toEqual({ value: 'legacy', source: 'file' }); expect(later).toHaveBeenCalledOnce()
    await broker.dispose()
  })
})
