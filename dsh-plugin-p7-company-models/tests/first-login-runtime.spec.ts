import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { AccountBroker } from '../src/account-broker.js'
import { installPersonalCredentialOverlay } from '../src/personal-credential-overlay.js'

const profile = (userId: string) => ({ userId, organizationId: 'org-1', displayName: userId, role: 'employee', deviceId: `device-${userId}`, sessionId: `session-${userId}`, scopes: ['model:use'] })
const sse = () => new Response('data: {"id":"chatcmpl-first-login","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })

async function collectStream(ctx: Context) {
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: 'p7-company-chat', model: 'p7-chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk)
  return chunks
}

describe('first personal login runtime boundary', () => {
  it('projects only the signed-in P7 bearer to an independent published runtime', async () => {
    let now = 1_700_000_000_000
    let login: Record<string, unknown> | undefined
    const credential = credentialRef('P7_FIRST_LOGIN_RUNTIME_KEY')
    const storedLegacyKey = vi.fn(async () => ({ value: 'p7k_stored-legacy-key', source: 'file' as const }))
    const companyctx = new Context()
    companyctx.provide('credentials', { resolve: storedLegacyKey, describe: vi.fn(async () => ({ configured: false, writable: true })), set: vi.fn(), unset: vi.fn() } as never)
    const consumerctx = companyctx.extend()
    new LlmRuntime(consumerctx)
    const modelRequests: string[] = []
    const modelFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://p7.example.invalid/v1/chat/completions')
      modelRequests.push(request.headers.get('authorization') ?? '')
      return sse()
    })
    const accountFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/policy')) return Response.json({ upgradeRequired: false })
      if (path.endsWith('/login-transactions')) {
        login = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({ transactionId: 'first-transaction', pollToken: 'first-poll', authorizationUrl: 'https://identity.example.invalid/authorize', expiresAt: now + 60_000 })
      }
      if (path.endsWith('/token')) return Response.json({ accessToken: 'p7d_first-account', refreshToken: 'p7r_first-account', expiresAt: now + 120_000, tokenType: 'Bearer', profile: profile('first-user') })
      if (path.endsWith('/token/refresh')) return Response.json({ accessToken: 'p7d_first-refreshed', refreshToken: 'p7r_first-refreshed', expiresAt: now + 120_000, tokenType: 'Bearer', profile: profile('first-user') })
      if (path.endsWith('/session/revoke')) return Response.json({ revoked: true })
      throw new Error(`unexpected P7 request: ${path}`)
    })
    const first = new AccountBroker({ origin: () => 'https://p7.example.invalid', profileId: 'first-login-runtime', requirePersonalLogin: true, openBrowser: () => {}, fetch: accountFetch, now: () => now })
    const removeFirstOverlay = installPersonalCredentialOverlay(companyctx.credentials, credential, first)
    const providers = {
      'p7-company-chat': {
        displayName: 'P7 personal route', api: 'openai-completions', baseURL: 'https://p7.example.invalid/v1', apiKeyEnv: 'P7_FIRST_LOGIN_RUNTIME_KEY', rejectRedirects: true, transport: 'sse' as const,
        models: [{ id: 'p7-chat', name: 'P7 chat', contextWindow: 4096, maxTokens: 1024 }],
      },
    }
    try {
      await consumerctx.plugin(piAi, { providers }).await()

      // A personal-only route must refuse before any model network call while signed out.
      await collectStream(consumerctx)
      expect(modelFetch).not.toHaveBeenCalled()
      expect(storedLegacyKey).not.toHaveBeenCalled()

      await first.login()
      await globalThis.fetch(`${String(login?.redirectUri)}?transactionId=first-transaction&state=${String(login?.state)}`)
      await vi.waitFor(() => expect(first.status().phase).toBe('signed-in'))
      await expect(consumerctx.credentials.describe(credential)).resolves.toEqual({ configured: true, source: 'p7-session', writable: false })

      // The consumer is a separate Cordis context, but resolves the projected credential.
      await expect(consumerctx.llm.listModels('p7-company-chat')).resolves.toMatchObject([{ id: 'p7-chat', name: 'P7 chat' }])
      await expect(consumerctx.llm.resolveModelInfo('p7-company-chat', 'p7-chat')).resolves.toMatchObject({ provider: 'p7-company-chat', id: 'p7-chat' })
      vi.stubGlobal('fetch', modelFetch)
      try {
        expect(await collectStream(consumerctx)).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
        expect(modelRequests).toEqual(['Bearer p7d_first-account'])

        now += 70_000
        expect(await collectStream(consumerctx)).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
        expect(modelRequests).toEqual(['Bearer p7d_first-account', 'Bearer p7d_first-refreshed'])
      } finally {
        vi.unstubAllGlobals()
      }

      await first.logout()
      await expect(consumerctx.credentials.describe(credential)).resolves.toEqual({ configured: false, writable: false })
      await collectStream(consumerctx)
      expect(modelRequests).toEqual(['Bearer p7d_first-account', 'Bearer p7d_first-refreshed'])
      expect(storedLegacyKey).not.toHaveBeenCalled()

      removeFirstOverlay()
      modelRequests.length = 0
      let secondLogin: Record<string, unknown> | undefined
      const second = new AccountBroker({ origin: () => 'https://p7.example.invalid', profileId: 'second-login-runtime', requirePersonalLogin: true, openBrowser: () => {}, now: () => now, fetch: async (input, init) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/policy')) return Response.json({ upgradeRequired: false })
        if (path.endsWith('/login-transactions')) {
          secondLogin = JSON.parse(String(init?.body)) as Record<string, unknown>
          return Response.json({ transactionId: 'second-transaction', pollToken: 'second-poll', authorizationUrl: 'https://identity.example.invalid/authorize', expiresAt: now + 60_000 })
        }
        if (path.endsWith('/token')) return Response.json({ accessToken: 'p7d_second-account', refreshToken: 'p7r_second-account', expiresAt: now + 120_000, tokenType: 'Bearer', profile: profile('second-user') })
        throw new Error(`unexpected second P7 request: ${path}`)
      } })
      const removeSecondOverlay = installPersonalCredentialOverlay(companyctx.credentials, credential, second)
      try {
        await second.login()
        await globalThis.fetch(`${String(secondLogin?.redirectUri)}?transactionId=second-transaction&state=${String(secondLogin?.state)}`)
        await vi.waitFor(() => expect(second.status().phase).toBe('signed-in'))
        vi.stubGlobal('fetch', modelFetch)
        try {
          await collectStream(consumerctx)
          expect(modelRequests).toEqual(['Bearer p7d_second-account'])
          expect(modelRequests).not.toContain('Bearer p7d_first-account')
          expect(modelRequests).not.toContain('Bearer p7d_first-refreshed')
        } finally {
          vi.unstubAllGlobals()
        }
      } finally {
        removeSecondOverlay()
        await second.dispose()
      }
    } finally {
      removeFirstOverlay()
      await first.dispose()
      await consumerctx.fiber.dispose()
      await companyctx.fiber.dispose()
    }
  })
})
