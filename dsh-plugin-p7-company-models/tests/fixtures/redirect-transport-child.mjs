import { Context } from '@deepseek-ai/cordis'
import * as adapterPlugin from '@deepseek-ai/dsh-llm-pi-ai'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

const [baseURL, api, mode] = process.argv.slice(2)
const ctx = new Context()
let adapter
const release = () => {}
const handle = Object.assign(release, { replace: () => {} })
ctx.provide('llm', {
  registerConfigurableProviders: () => handle,
  registerModelDiscovery: () => release,
  registerAdapter: (_providers, captured) => { adapter = captured; return handle },
})
ctx.provide('credentials', { resolve: async () => ({ value: 'p7k_redirect_test_key' }) })
try {
  await ctx.plugin(adapterPlugin, { providers: { p7: {
    api, baseURL, apiKeyEnv: 'P7_TEST_KEY', ...(mode === 'unmanaged' ? {} : { rejectRedirects: true }), transport: 'sse',
    models: [{ id: 'test-model', name: 'test', contextWindow: 2048, maxTokens: 128, input: ['text'] }],
  } } })
  const chunks = []
  let failure
  try {
    for await (const chunk of adapter.stream({ provider: 'p7', model: 'test-model', messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }] })] })) chunks.push(chunk)
  } catch (error) {
    failure = error
  }
  if (mode === 'redirect' || mode === 'untrusted') {
    if (failure === undefined && !chunks.some(chunk => chunk.type === 'finish' && chunk.reason?.kind === 'error')) throw new Error(`redirect unexpectedly completed: ${JSON.stringify(chunks)}`)
    process.stdout.write(mode === 'untrusted' ? 'tls-rejected' : 'redirect-rejected')
  } else {
    if (failure !== undefined) throw failure
    if (chunks.some(chunk => chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind))) throw new Error(`Normal SSE failed: ${JSON.stringify(chunks)}`)
    const assembled = new BlockAssembler()
    for (const chunk of chunks) assembled.push(chunk)
    if (!assembled.blocks().some(block => block.type === 'text' && block.text === 'ok')) throw new Error(`Normal SSE produced no expected text: ${JSON.stringify(chunks)}`)
    if (!chunks.some(chunk => chunk.type === 'finish' && chunk.reason?.kind === 'stop')) throw new Error(`Normal SSE did not complete: ${JSON.stringify(chunks)}`)
    process.stdout.write('ok')
  }
} finally {
  await ctx.fiber.dispose()
}
