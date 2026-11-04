import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from './p7-compaction-summary-routing.mjs'

function fixture() {
  let handler
  const calls = []
  let delegated = 0
  const ctx = {
    on(event, fn) { assert.equal(event, 'llm/stream'); handler = fn },
    logger: { info() {} },
    llm: { stream(options) {
      return handler(options, async function* () { delegated++; calls.push(options); yield { type: 'finish', reason: { kind: 'stop' } } })
    } },
  }
  apply(ctx)
  return { ctx, calls, delegated: () => delegated }
}

test('compaction dispatches once to Gemini with original payload and cancellation', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const options = Object.freeze({ provider: 'p7-company-chat', model: 'DeepSeek-V4.1-Flash', purpose: 'compaction', messages: [], tools: [], maxTokens: 65536, signal })
  for await (const _ of f.ctx.llm.stream(options)) { /* consume the fake stream */ }
  assert.equal(f.delegated(), 1)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].provider, 'p7-company-chat')
  assert.equal(f.calls[0].model, 'gemini-3.8-flash-tiered')
  assert.equal(f.calls[0].messages, options.messages)
  assert.equal(f.calls[0].signal, signal)
  assert.equal(options.model, 'DeepSeek-V4.1-Flash')
})

test('regular local Agent requests remain on the same route', async () => {
  const f = fixture()
  const options = Object.freeze({ provider: 'p7-company-chat', model: 'DeepSeek-V4.1-Flash', purpose: 'agent', messages: [] })
  for await (const _ of f.ctx.llm.stream(options)) { /* consume */ }
  assert.equal(f.delegated(), 1)
  assert.equal(f.calls[0], options)
})

test('other providers and existing Gemini summaries are unchanged', async () => {
  for (const options of [
    { provider: 'other', model: 'DeepSeek-V4.1-Flash', purpose: 'compaction', messages: [] },
    { provider: 'p7-company-chat', model: 'gemini-3.8-flash-tiered', purpose: 'compaction', messages: [] },
  ]) {
    const f = fixture()
    for await (const _ of f.ctx.llm.stream(options)) { /* consume */ }
    assert.equal(f.delegated(), 1)
    assert.equal(f.calls[0], options)
  }
})
