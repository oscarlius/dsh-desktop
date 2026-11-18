/** Verify the rc.1 trajectory display-name seam without installing a company plugin. */
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const root = resolve(import.meta.dirname, '..')
const archive = join(root, 'vendor', 'dsh-runtime', '0.2.2-rc.1', 'deepseek-ai-dsh-client-ui-trajectory-0.2.2-rc.1.tgz')
const patchPath = join(root, 'patches', 'dsh-client-ui-trajectory@0.2.2-rc.1.patch')

function tarEntry(tgz, wanted) {
  const tar = gunzipSync(readFileSync(tgz))
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/u, '')
    const sizeText = tar.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/u, '').trim()
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    const body = offset + 512
    if (name === wanted) return tar.subarray(body, body + size).toString('utf8')
    offset = body + Math.ceil(size / 512) * 512
  }
  throw new Error(`tar entry not found: ${wanted}`)
}

function patchHunks(text) {
  const hunks = []
  let oldLines
  let newLines
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('@@ ')) {
      if (oldLines !== undefined) hunks.push({ oldLines, newLines })
      oldLines = []
      newLines = []
      continue
    }
    if (oldLines === undefined) continue
    if (line.startsWith(' ')) {
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    } else if (line.startsWith('-')) oldLines.push(line.slice(1))
    else if (line.startsWith('+')) newLines.push(line.slice(1))
  }
  if (oldLines !== undefined) hunks.push({ oldLines, newLines })
  return hunks
}

function applyInMemory(source, patch) {
  let transformed = source
  for (const { oldLines, newLines } of patchHunks(patch)) {
    const oldText = oldLines.join('\n')
    const newText = newLines.join('\n')
    assert.notEqual(transformed.indexOf(oldText), -1, `patch anchor missing from shipped rc.1 bundle: ${oldLines.at(0)}`)
    transformed = transformed.replace(oldText, newText)
  }
  return transformed
}

function functionFromBundle(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\t\\t\\}`, 'u'))
  assert.ok(match, `patched ${name} function must exist`)
  return runInNewContext(`(${match[0]})`)
}

test('rc.1 trajectory patch localizes call labels without changing recorded identities', () => {
  const shipped = tarEntry(archive, 'package/lib/client.js')
  const patch = readFileSync(patchPath, 'utf8')
  const transformed = applyInMemory(shipped, patch)
  const raw = 'mcp__p7__weknora__ask'
  assert.equal((transformed.match(/"tool\.displayName": "\{name\}",/gu) ?? []).length, 8,
    'all eight runtime dictionaries must provide the default interpolation value')
  const chinese = (key, { name }) => key === 'tool.displayName' && name === raw ? 'WeKnora 问答' : name
  const defaultTemplate = JSON.parse(transformed.match(/"tool\.displayName": ("[^"]*")/u)[1])
  const defaultLocale = (_key, { name }) => defaultTemplate.replace('{name}', name)

  // The patch must target all concrete render paths in the shipped bundle, not
  // merely the stale source submodule.
  assert.match(transformed, /function summarizeCall\(name, argsRaw, t\)/u)
  assert.match(transformed, /summarizeCall\(call\.name, call\.argsRaw, t\)/u) // running
  assert.match(transformed, /summarizeCall\(block\.name, block\.argsRaw, t\)/u) // assistant/settled
  assert.match(transformed, /summarizeCall\(sub\.name, sub\.argsRaw, t\)/u) // subcall
  assert.match(transformed, /call\.toolName === void 0 \? t\("details\.toolCall"\) : t\("tool\.displayName", \{ name: call\.toolName \}\)/u)
  assert.match(transformed, /const displayName = t\("tool\.displayName", \{ name \}\)/u)
  assert.equal(transformed.includes('toolName: t('), false, 'translation must not overwrite durable raw toolName')

  const summarizeCall = functionFromBundle(transformed, 'summarizeCall')
  const groupDescription = functionFromBundle(transformed, 'groupDescription')
  const argsRaw = '{"query":"贵州茅台"}'
  const call = { toolName: raw, callId: 'call-17', argsRaw, schema: { type: 'object' }, source: { seq: 7 } }
  const rendered = summarizeCall(call.toolName, call.argsRaw, chinese)
  assert.equal(rendered.text, 'WeKnora 问答')
  assert.equal(rendered.toolName, raw)
  assert.equal(rendered.previewMarkdown, argsRaw)
  assert.equal(call.callId, 'call-17')
  assert.equal(call.argsRaw, argsRaw)
  assert.equal(summarizeCall(raw, argsRaw, defaultLocale).text, raw, 'default locale keeps original row label')
  const compact = transformed.match(/children: (call\.toolName === void 0 \? t\("details\.toolCall"\) : t\("tool\.displayName", \{ name: call\.toolName \}\))/u)[1]
  assert.equal(runInNewContext(compact, { call, t: chinese }), 'WeKnora 问答', 'actual compact assistant expression')
  assert.equal(groupDescription([{ absTime: null, toolName: raw, cell: { kind: 'tool' } }, { absTime: null, toolName: raw, cell: { kind: 'tool' } }], chinese), 'WeKnora 问答×2', 'actual compact group function')
})
