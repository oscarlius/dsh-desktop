import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { describe, expect, it, vi } from 'vitest'

describe('company reasoning protocol boundary', () => {
  it('offers the published tiers and sends low by default while retaining an explicit high request', async () => {
    const ctx = new Context()
    ctx.provide('credentials', { resolve: async () => ({ value: 'test-host-only-token', source: 'p7-session' }), describe: async () => ({ configured: true, writable: false }), set: vi.fn(), unset: vi.fn() } as never)
    new LlmRuntime(ctx)
    const requests: Record<string, unknown>[] = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response('data: {"id":"reasoning-test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    try {
      await ctx.plugin(piAi, { providers: { 'p7-company-chat': {
        api: 'openai-completions', baseURL: 'https://p7.example.invalid/v1', apiKeyEnv: 'P7_TEST_KEY', reasoning: 'low', transport: 'sse',
        models: [{ id: 'published-model', name: 'Company model', contextWindow: 4096, maxTokens: 512, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } }],
      } } }).await()
      const info = await ctx.llm.resolveModelInfo('p7-company-chat', 'published-model')
      expect(info.reasoning?.efforts.map(x => x.id)).toEqual(['low', 'medium', 'high'])
      expect(info.reasoning?.defaultEffort).toBe('low')
      vi.stubGlobal('fetch', fetch)
      for (const effort of [undefined, ReasoningEffortId('high')]) {
        const chunks = []
        for await (const chunk of ctx.llm.stream({ provider: 'p7-company-chat', model: 'published-model', ...(effort ? { reasoningEffort: effort } : {}), messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) chunks.push(chunk)
        expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
      }
      expect(requests.map(r => r.reasoning_effort)).toEqual(['low', 'high'])
    } finally {
      vi.unstubAllGlobals()
      await ctx.fiber.dispose()
    }
  })
})
