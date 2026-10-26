import { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { installInlineThinkingNormalizer } from '../src/inline-thinking.js'

const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })

async function fixture() {
  const ctx = new Context(); new LlmRuntime(ctx)
  ctx.provide('credentials', { resolve: async () => ({ value: 'synthetic' }) } as never)
  await ctx.plugin({ name: 'p7-inline-test', inject: { llm: true }, apply: installInlineThinkingNormalizer }).await()
  const provider = { displayName: 'P7', api: 'openai-completions', baseURL: 'https://p7.invalid/v1', apiKeyEnv: 'P7_TEST', models: [{ id: 'qwen', name: 'Qwen', contextWindow: 8192, maxTokens: 1024 }] }
  await ctx.plugin(piAi, { providers: { 'p7-company-chat': provider, personal: provider } }).await()
  return ctx
}

describe('company inline thinking runtime integration', () => {
  it('normalizes the official pi-ai company route, preserves tools/usage, and leaves personal routes unchanged', async () => {
    const ctx = await fixture()
    const raw = '<think>plan</think>Answer'
    const fetch = vi.fn(async () => sse([
      { id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '<thi' }, finish_reason: null }] },
      { id: 'x', choices: [{ index: 0, delta: { content: 'nk>plan</think>Answer', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: null }] },
      { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
    ]))
    try {
      vi.stubGlobal('fetch', fetch)
      for (const provider of ['p7-company-chat', 'personal']) {
        const assembler = new BlockAssembler()
        for await (const chunk of ctx.llm.stream({ provider, model: 'qwen', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 'lookup', description: 'x', parameters: { type: 'object' } }] })) assembler.push(chunk)
        expect(assembler.blocks()).toEqual([
          ...(provider === 'personal' ? [{ type: 'text', text: raw }] : [{ type: 'reasoning', text: 'plan' }, { type: 'text', text: 'Answer' }]),
          { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{}' },
        ])
        expect(assembler.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, totalTokens: 5 })
      }
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals(); await ctx.fiber.dispose() }
  })

  it('applies the same single registered hook to successive real auxiliary title requests', async () => {
    const ctx = await fixture()
    const fetch = vi.fn(async () => sse([
      { id: 'title', choices: [{ index: 0, delta: { role: 'assistant', content: '<think>Choose a short title</think>Clean title' }, finish_reason: null }] },
      { id: 'title', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]))
    try {
      vi.stubGlobal('fetch', fetch)
      for (let call = 0; call < 2; call++) {
        const assembler = new BlockAssembler()
        for await (const chunk of ctx.llm.stream({ provider: 'p7-company-chat', model: 'qwen', purpose: 'session-title', messages: [{ role: 'user', content: [{ type: 'text', text: 'Give this conversation a title' }] }] })) assembler.push(chunk)
        expect(assembler.blocks()).toEqual([{ type: 'reasoning', text: 'Choose a short title' }, { type: 'text', text: 'Clean title' }])
        expect(assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join(' ')).toBe('Clean title')
      }
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals(); await ctx.fiber.dispose() }
  })
})
