/** Exercise the actual patched rc.1 bundle against pi-ai's overflow predicate. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'

const root = process.env.DSH_COMPAT_SOURCE_ROOT ?? resolve(import.meta.dirname, '..')
const runtimeRequire = createRequire(join(root, 'dsh-plugin-desktop-beta', 'package.json'))
const overflowPath = process.env.DSH_PI_AI_OVERFLOW_PATH
  ?? createRequire(runtimeRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')).resolve('@earendil-works/pi-ai/utils/overflow')
const { isContextOverflow } = await import(pathToFileURL(overflowPath).href)

function tarEntry(path, wanted) {
  const tar = gunzipSync(readFileSync(path))
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/u, '')
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/u, '').trim() || '0', 8)
    const body = offset + 512
    if (name === wanted) return tar.subarray(body, body + size).toString()
    offset = body + Math.ceil(size / 512) * 512
  }
  throw new Error(`Missing tar entry: ${wanted}`)
}

const original = tarEntry(join(root, 'vendor/dsh-runtime/0.2.2-rc.1/deepseek-ai-dsh-llm-pi-ai-0.2.2-rc.1.tgz'), 'package/lib/index.js')
const patch = readFileSync(process.env.DSH_PI_AI_PATCH_PATH ?? join(root, 'patches/dsh-llm-pi-ai@0.2.2-rc.1.patch'), 'utf8')
const section = patch.split(/^diff --git /mu).find(part => part.startsWith('a/lib/index.js b/lib/index.js\n'))
assert.ok(section, 'patch must retain the runtime bundle section')
let transformed = original
for (const hunk of section.split(/^@@ .*@@.*\n/mu).slice(1)) {
  const lines = hunk.split('\n').filter(line => /^[ +\-]/u.test(line))
  const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n')
  const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n')
  assert.ok(transformed.includes(before), 'patch must apply to the pinned published bundle')
  transformed = transformed.replace(before, after)
}
assert.match(transformed, /function rejectRedirectsFetch/u, 'retain the existing transport protection')
const body = transformed.match(/^function mapStopReason\([\s\S]*?^\}/mu)?.[0]
assert.ok(body)
const mapStopReason = runInNewContext(`(${body})`, {
  isContextOverflow,
  isContextWindowExceededError: message => /context[_ ](?:length[_ ]exceeded|window)|maximum context/iu.test(message),
  classifyPiAiError: () => 'INVALID_REQUEST',
  CONTEXT_WINDOW_EXCEEDED_CODE: 'CONTEXT_WINDOW_EXCEEDED',
  EMPTY_RESPONSE_CODE: 'EMPTY_RESPONSE',
})
const mapped = message => JSON.parse(JSON.stringify(mapStopReason(message, 131072)))
const response = (overrides = {}) => ({
  model: 'proxy-alias', stopReason: 'stop', content: [{ type: 'text', text: 'Completed answer' }],
  usage: { input: 150670, output: 14, cacheRead: 0, cacheWrite: 0, totalTokens: 150684 },
  ...overrides,
})

test('a successful fallback answer above the alias window remains successful', () => {
  assert.equal(isContextOverflow(response(), 131072), true, 'reproduce the production pi-ai heuristic')
  assert.deepEqual(mapped(response()), { kind: 'stop' })
})

for (const content of [[], [{ type: 'text', text: '' }], [{ type: 'text', text: '  ' }], [{ type: 'thinking', thinking: 'Unfinished reasoning' }]]) {
  test(`no usable answer does not suppress overflow: ${JSON.stringify(content)}`, () => {
    assert.equal(mapped(response({ content })).failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  })
}

test('zero reported output does not turn a usage overflow into success', () => {
  assert.equal(mapped(response({ usage: { input: 150670, output: 0, cacheRead: 0, cacheWrite: 0 } })).failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('an explicit upstream overflow remains an error despite partial text', () => {
  assert.equal(mapped(response({ stopReason: 'error', errorMessage: 'maximum context length exceeded' })).failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('an unrelated provider rejection is not converted to a success', () => {
  assert.deepEqual(mapped(response({ stopReason: 'error', errorMessage: '400 invalid request body' })), {
    kind: 'error', failure: { message: '400 invalid request body', code: 'INVALID_REQUEST' },
  })
})

test('cancellation after partial text remains cancelled', () => {
  assert.equal(mapped(response({ stopReason: 'aborted' })).kind, 'aborted')
})

test('zero-output length overflow remains an error', () => {
  const message = response({ stopReason: 'length', content: [], usage: { input: 150670, output: 0, cacheRead: 0, cacheWrite: 0 } })
  assert.equal(mapped(message).failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('output limits and tool-call completions preserve their terminal reasons', () => {
  assert.deepEqual(mapped(response({ stopReason: 'length' })), { kind: 'max-tokens' })
  assert.deepEqual(mapped(response({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call_1', name: 'check', arguments: {} }] })), { kind: 'tool-calls' })
})
