import { Context } from '@deepseek-ai/cordis'
import * as adapterPlugin from '@deepseek-ai/dsh-llm-pi-ai'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { mapConfigToProviders } from '../src/map-providers.js'
import { validateModelConfig } from '../src/validate-config.js'
import { config } from './fixtures/config.js'

describe('real published model adapter', () => {
  it('streams the administrator alias through the managed OpenAI-compatible route', async () => {
    const ctx = new Context()
    let adapter: LlmAdapter | undefined
    const release = () => {}
    const handle = Object.assign(release, { replace: () => {} })
    ctx.provide('llm', {
      registerConfigurableProviders: () => handle, registerModelDiscovery: () => release,
      registerAdapter: (_providers: unknown, captured: LlmAdapter) => { adapter = captured; return handle },
    } as never)
    ctx.provide('credentials', { resolve: async () => ({ value: 'p7k_synthetic-test-key' }), listRecords: async () => [], resolveRecord: async () => undefined } as never)
    const providers = mapConfigToProviders(validateModelConfig(config({
      models: [
        ...config().models,
        { id: 'responses-alias', displayName: 'Responses alias', api: 'openai-responses', contextWindow: 2048, maxOutputTokens: 512, inputModalities: ['text'], streaming: true, tools: true },
        { id: 'messages-alias', displayName: 'Messages alias', api: 'anthropic-messages', contextWindow: 8192, maxOutputTokens: 2048, inputModalities: ['text'], streaming: true, tools: true },
      ],
    })), { origin: 'https://p7.example.invalid', credentialRef: 'P7_TEST_KEY' })
    const profiles = Object.fromEntries(providers.map(provider => [provider.id, {
      api: provider.api, baseURL: provider.baseURL, apiKeyEnv: provider.credentialRef, rejectRedirects: provider.rejectRedirects, transport: provider.transport, models: provider.models,
    }]))
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://p7.example.invalid/v1/chat/completions')
      expect(request.redirect).toBe('error')
      expect(request.headers.get('authorization')).toBe('Bearer p7k_synthetic-test-key')
      expect(await request.json()).toMatchObject({
        model: 'admin-alias',
        stream: true,
        tools: [{ type: 'function', function: { name: 'lookup_weather', description: 'Look up the weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      })
      return new Response([
        { id: 'chatcmpl-p7-test', object: 'chat.completion.chunk', created: 0, model: 'admin-alias', choices: [{ index: 0, delta: { role: 'assistant', content: 'Weather: ' }, finish_reason: null }] },
        { id: 'chatcmpl-p7-test', object: 'chat.completion.chunk', created: 0, model: 'admin-alias', choices: [{ index: 0, delta: { content: 'sunny', tool_calls: [{ index: 0, id: 'call_weather', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Shanghai"}' } }] }, finish_reason: null }] },
        { id: 'chatcmpl-p7-test', object: 'chat.completion.chunk', created: 0, model: 'admin-alias', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { id: 'chatcmpl-p7-test', object: 'chat.completion.chunk', created: 0, model: 'admin-alias', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    try {
      vi.stubGlobal('fetch', fetch)
      await ctx.plugin(adapterPlugin, { providers: profiles })
      expect(adapter).toBeDefined()
      await expect(adapter!.listModels('p7-company-chat')).resolves.toMatchObject([{ id: 'admin-alias', name: 'Administrator supplied name' }])
      await expect(adapter!.listModels('p7-company-responses')).resolves.toMatchObject([{ id: 'responses-alias', name: 'Responses alias' }])
      await expect(adapter!.listModels('p7-company-messages')).resolves.toMatchObject([{ id: 'messages-alias', name: 'Messages alias' }])
      const exact = await adapter!.resolveModel('p7-company-chat', 'admin-alias')
      expect(JSON.stringify(exact)).toContain('4096')
      expect(JSON.stringify(exact)).toContain('1024')
      const chunks = []
      for await (const chunk of adapter!.stream({
        provider: 'p7-company-chat', model: 'admin-alias',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Shanghai?' }] }],
        tools: [{ name: 'lookup_weather', description: 'Look up the weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      })) chunks.push(chunk)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Weather: ' })
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'sunny' })
      expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 1, id: 'call_weather', name: 'lookup_weather', argumentsDelta: '{"city":"Shanghai"}' })
      expect(chunks).toContainEqual({ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_weather', name: 'lookup_weather', arguments: '{"city":"Shanghai"}' } })
    } finally {
      vi.unstubAllGlobals()
      await ctx.fiber.dispose()
    }
  })
})
