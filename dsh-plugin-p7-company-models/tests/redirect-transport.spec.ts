import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as import('node:net').AddressInfo).port)) })
const close = (server: ReturnType<typeof createServer>) => new Promise<void>(resolve => server.close(() => resolve()))
function sse(api: string): string {
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
  const events = api === 'openai-completions' ? [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
  ] : api === 'openai-responses' ? [
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ] : [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return events.map(event => `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (api === 'openai-completions' ? 'data: [DONE]\n\n' : '')
}
const endpoint = (api: string) => api === 'openai-completions' ? '/v1/chat/completions' : api === 'openai-responses' ? '/v1/responses' : '/v1/messages'

describe('published pi-ai redirect transport', () => {
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)('rejects 302 and 307 before a cross-origin sink for %s while normal SSE succeeds', async api => {
    const key = fileURLToPath(new URL('./fixtures/localhost-key.pem', import.meta.url))
    const cert = fileURLToPath(new URL('./fixtures/localhost-cert.pem', import.meta.url))
    const options = { key: readFileSync(key), cert: readFileSync(cert) }
    const sinkRequests: { authorization: string | undefined }[] = []
    const sink = createServer(options, (request, response) => { sinkRequests.push({ authorization: request.headers.authorization }); request.resume(); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(sse(api)) })
    const sinkPort = await listen(sink)
    let redirect = false
    let sourceRequests = 0
    const source = createServer(options, (request, response) => {
      sourceRequests++
      request.resume()
      if (new URL(request.url ?? '/', 'https://localhost').pathname !== endpoint(api)) { response.writeHead(404); response.end(`unexpected route ${request.url}`); return }
      if (redirect) { response.writeHead(sourceRequests % 2 ? 302 : 307, { location: `https://localhost:${sinkPort}/sink` }); response.end(); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(sse(api))
    })
    const sourcePort = await listen(source)
    const child = fileURLToPath(new URL('./fixtures/redirect-transport-child.mjs', import.meta.url))
    const baseURL = `https://localhost:${sourcePort}${api === 'anthropic-messages' ? '' : '/v1'}`
    const invoke = (mode: 'normal' | 'redirect' | 'untrusted' | 'unmanaged') => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const childProcess = spawn(process.execPath, [child, baseURL, api, mode], { cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: mode === 'untrusted' ? '' : cert } })
      let stdout = '', stderr = ''
      childProcess.stdout.on('data', chunk => { stdout += chunk })
      childProcess.stderr.on('data', chunk => { stderr += chunk })
      childProcess.on('error', reject)
      childProcess.on('close', status => resolve({ status, stdout, stderr }))
    })
    try {
      const untrusted = await invoke('untrusted')
      expect(untrusted.status, untrusted.stderr).toBe(0)
      expect(untrusted.stdout).toContain('tls-rejected')
      expect(sourceRequests).toBe(0)
      const normal = await invoke('normal')
      expect(normal.status, normal.stderr).toBe(0)
      expect(normal.stdout).toContain('ok')
      redirect = true
      for (const status of [302, 307]) {
        sourceRequests = status === 302 ? 0 : 1
        const rejected = await invoke('redirect')
        expect(rejected.status, rejected.stderr).toBe(0)
        expect(rejected.stdout).toContain('redirect-rejected')
        expect(sinkRequests).toEqual([])
      }
      const unmanaged = await invoke('unmanaged')
      expect(unmanaged.status, unmanaged.stderr).toBe(0)
      expect(sinkRequests).toHaveLength(1)
    } finally { await close(source); await close(sink) }
  }, 30_000)
})
