import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './p7-compaction-summary-routing.mjs'

const overflowFor = (model) => `pi-ai detected context overflow for model "${model}"`
const local = { provider: 'p7-company-chat', model: 'DeepSeek-V4.1-Flash' }

function fixture({ models = [], chunks = [{ type: 'finish', reason: { kind: 'stop' } }] } = {}) {
  let handler
  const calls = []
  let delegated = 0
  let listed = 0
  const ctx = {
    on(event, fn) { assert.equal(event, 'llm/stream'); handler = fn },
    logger: { info() {}, warn() {} },
    llm: {
      async listModels(provider) { listed++; assert.equal(provider, 'p7-company-chat'); return models },
      stream(options) {
        return handler.call(ctx.llm, options, async function* () {
          delegated++
          calls.push(options)
          yield* chunks
        })
      },
    },
  }
  apply(ctx)
  return { ctx, calls, delegated: () => delegated, listed: () => listed }
}

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('missing Gemini keeps the original compaction route and recovers its completed old-adapter summary', async () => {
  const text = { type: 'text-delta', index: 0, text: 'summary completed' }
  const usage = { type: 'usage', usage: { inputTokens: 150670, outputTokens: 14 } }
  const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: overflowFor(local.model) } } }
  const f = fixture({ chunks: [text, usage, finish] })
  const options = Object.freeze({ ...local, purpose: 'compaction', messages: [], tools: [] })
  const received = await collect(f.ctx.llm.stream(options))
  assert.equal(f.listed(), 1)
  assert.equal(f.delegated(), 1)
  assert.equal(f.calls[0], options)
  assert.equal(received[0], text)
  assert.equal(received[1], usage)
  assert.deepEqual(received[2], { type: 'finish', reason: { kind: 'stop' } })
})

test('available Gemini receives a shallow routed copy with original payload references', async () => {
  const f = fixture({ models: [{ id: 'gemini-3.8-flash-tiered' }] })
  const signal = new AbortController().signal
  const options = Object.freeze({ ...local, purpose: 'compaction', messages: [], tools: [], signal })
  await collect(f.ctx.llm.stream(options))
  assert.equal(f.delegated(), 1)
  assert.equal(f.calls[0].provider, 'p7-company-chat')
  assert.equal(f.calls[0].model, 'gemini-3.8-flash-tiered')
  assert.equal(f.calls[0].messages, options.messages)
  assert.equal(f.calls[0].tools, options.tools)
  assert.equal(f.calls[0].signal, signal)
  assert.equal(options.model, 'DeepSeek-V4.1-Flash')
})

test('normal requests keep genuine provider failures unchanged', async () => {
  const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: 'provider failed' } } }
  const f = fixture({ chunks: [finish] })
  const received = await collect(f.ctx.llm.stream({ ...local, purpose: 'agent' }))
  assert.equal(received[0], finish)
})

test('recovers only the known old-adapter overflow after visible text and output usage', async () => {
  const qwen = { provider: 'p7-company-responses', model: 'Qwen3.8-Flash-Next' }
  const text = { type: 'text-delta', index: 0, text: 'completed answer' }
  const usage = { type: 'usage', usage: { inputTokens: 150670, outputTokens: 14 } }
  const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: overflowFor(qwen.model) } } }
  const f = fixture({ chunks: [text, usage, finish] })
  const received = await collect(f.ctx.llm.stream({ ...qwen, purpose: 'agent' }))
  assert.equal(received[0], text)
  assert.equal(received[1], usage)
  assert.deepEqual(received[2], { type: 'finish', reason: { kind: 'stop' } })
})

test('does not heal thinking-only output or zero output usage', async () => {
  const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: overflowFor(local.model) } } }
  for (const chunks of [
    [{ type: 'reasoning-delta', index: 0, text: 'thinking' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 4 } }, finish],
    [{ type: 'text-delta', index: 0, text: 'answer' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } }, finish],
  ]) {
    const f = fixture({ chunks })
    const received = await collect(f.ctx.llm.stream({ ...local, purpose: 'agent' }))
    assert.equal(received.at(-1), finish)
  }
})

test('does not convert aborted, max-token, wrong-code, or non-local overflow finishes', async () => {
  const variants = [
    { ...local, purpose: 'agent', chunks: [{ type: 'text-delta', index: 0, text: 'answer' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'aborted', failure: { message: overflowFor(local.model) } } }] },
    { ...local, purpose: 'agent', chunks: [{ type: 'text-delta', index: 0, text: 'answer' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'max-tokens' } }] },
    { ...local, purpose: 'agent', chunks: [{ type: 'text-delta', index: 0, text: 'answer' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP', message: overflowFor(local.model) } } }] },
    { provider: 'other', model: local.model, purpose: 'agent', chunks: [{ type: 'text-delta', index: 0, text: 'answer' }, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: overflowFor(local.model) } } }] },
  ]
  for (const { chunks, ...options } of variants) {
    const f = fixture({ chunks })
    const received = await collect(f.ctx.llm.stream(options))
    assert.equal(received.at(-1), chunks.at(-1))
  }
})

test('caller abort after text and usage keeps the synthetic overflow error', async () => {
  const controller = new AbortController()
  const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: overflowFor(local.model) } } }
  async function* chunks() {
    yield { type: 'text-delta', index: 0, text: 'completed answer' }
    yield { type: 'usage', usage: { inputTokens: 150670, outputTokens: 14 } }
    controller.abort()
    yield finish
  }
  const f = fixture({ chunks: chunks() })
  const received = await collect(f.ctx.llm.stream({ ...local, purpose: 'agent', signal: controller.signal }))
  assert.equal(received.at(-1), finish)
})

test('an already-aborted compaction request is delegated unchanged without lookup', async () => {
  const controller = new AbortController()
  controller.abort()
  const f = fixture({ models: [{ id: 'gemini-3.8-flash-tiered' }] })
  const options = { ...local, purpose: 'compaction', signal: controller.signal }
  await collect(f.ctx.llm.stream(options))
  assert.equal(f.listed(), 0)
  assert.equal(f.calls[0], options)
})
