import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { P7ConnectionResolver } from '../src/connection.js'

describe('P7 personal credential resolution', () => {
  it('uses an effective personal token for each operation instead of the legacy key', async () => {
    const personalAccessToken = vi.fn(async () => 'personal-access')
    const resolver = new P7ConnectionResolver({ credentialRef: credentialRef('P7_TEST_API_KEY'), configuredOrigin: 'https://p7.example', configuredApiKey: 'legacy-key', persistenceFile: 'missing', requestTimeoutMs: 1000, ambientApiKey: () => 'ambient-key', usesPersonalToken: () => true, personalAccessToken })
    expect((await resolver.resolve()).apiKey).toBe('personal-access')
    // Activation and the request each resolve afresh; no token snapshot is cached.
    expect(personalAccessToken).toHaveBeenCalledTimes(2)
  })

  it('does not silently fall back to a shared key once a personal session was selected and expired', async () => {
    const resolver = new P7ConnectionResolver({ credentialRef: credentialRef('P7_TEST_API_KEY'), configuredOrigin: 'https://p7.example', configuredApiKey: 'legacy-key', persistenceFile: 'missing', requestTimeoutMs: 1000, ambientApiKey: () => 'ambient-key', usesPersonalToken: () => true, personalAccessToken: async () => { throw new Error('expired') } })
    expect((await resolver.resolve()).apiKey).toBe('')
  })

  it('preserves the legacy connection before personal sign-in is selected', async () => {
    const resolver = new P7ConnectionResolver({ credentialRef: credentialRef('P7_TEST_API_KEY'), configuredOrigin: 'https://p7.example', configuredApiKey: 'legacy-key', persistenceFile: 'missing', requestTimeoutMs: 1000, ambientApiKey: () => undefined, usesPersonalToken: () => false, personalAccessToken: async () => 'personal-access' })
    expect((await resolver.resolve()).apiKey).toBe('legacy-key')
  })
})
