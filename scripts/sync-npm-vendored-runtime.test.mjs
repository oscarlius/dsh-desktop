import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { syncNpmVendoredRuntime } from './sync-npm-vendored-runtime.mjs'

const version = '0.2.2-rc.1'
const registry = 'https://registry.npmjs.org'
const integrity = value => `sha512-${createHash('sha512').update(value).digest('base64')}`

test('write preserves an existing same-tarball custom patch resolution', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vendor-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`)
  }
  const controller = 'deepseek-ai-dsh-api-session-controller-0.2.2-rc.1.tgz'
  const custom = `patch:@deepseek-ai/dsh-api-session-controller@file%3Avendor/dsh-runtime/${version}/${controller}#./.yarn/patches/qwen.patch`
  write('package.json', { resolutions: {
    '@deepseek-ai/dsh-api-session-controller@npm:0.2.2-rc.1': custom,
    '@deepseek-ai/dsh-api-session-controller@npm:^0.2.2-rc.1': custom,
  } })
  for (const path of ['dsh-plugin-desktop-beta', 'dsh-desktop-next', 'dsh-community-market', 'dsh-plugin-p7-mcp', 'dsh-plugin-p7-company-models', 'dsh-plugin-p7-web-search']) {
    write(`${path}/package.json`, { dependencies: path === 'dsh-plugin-desktop-beta'
      ? { '@deepseek-ai/dsh': version, '@deepseek-ai/dsh-api-session-controller': version } : {} })
  }
  mkdirSync(join(root, 'patches'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    const value = String(url)
    if (value.includes('/tarballs/')) return new Response(Buffer.from(value), { status: 200 })
    const name = decodeURIComponent(new URL(value).pathname.split('/').slice(1, -1).join('/'))
    const tarball = `${registry}/tarballs/${encodeURIComponent(name)}`
    return new Response(JSON.stringify({ name, version, dist: { integrity: integrity(tarball), tarball } }), { status: 200 })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const dshTarball = `${registry}/tarballs/${encodeURIComponent('@deepseek-ai/dsh')}`
  await syncNpmVendoredRuntime({ mode: '--write', channel: 'beta', rootDir: root,
    upstreamDocument: { repository: 'https://example.invalid/dsh' }, upstream: { sourceVersion: version,
      commit: `npm:@deepseek-ai/dsh@${version}`, releaseSource: { kind: 'npm', registry, package: '@deepseek-ai/dsh', version, integrity: integrity(dshTarball) } } })
  const result = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).resolutions
  assert.equal(result['@deepseek-ai/dsh-api-session-controller@npm:0.2.2-rc.1'], custom)
  assert.equal(result['@deepseek-ai/dsh-api-session-controller@npm:^0.2.2-rc.1'], custom)
})
