import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCompanyDifferences, variantContentHash } from './verify-desktop-variants.mjs'

test('declared company differences reject escaping, duplicate and wildcard paths', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-variant-contract-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'manifest.json')
  const entry = { path: 'src/main.ts', reason: 'Company login bridge', betaSha256: 'a'.repeat(64), nextSha256: 'b'.repeat(64) }
  const save = files => writeFileSync(path, JSON.stringify({ schemaVersion: 1, upstreamCommit: 'c'.repeat(40), files }))
  save([entry]); assert.equal(readCompanyDifferences(path).size, 1)
  for (const value of ['../main.ts', '/src/main.ts', 'src\\main.ts', 'src//main.ts', 'src/*']) {
    save([{ ...entry, path: value }]); assert.throws(() => readCompanyDifferences(path))
  }
  save([entry, entry]); assert.throws(() => readCompanyDifferences(path))
})

test('reviewed hashes ignore checkout line endings but detect content changes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-variant-content-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'source.ts')
  writeFileSync(path, 'original\r\n'); const hash = variantContentHash(path)
  writeFileSync(path, 'original\n'); assert.equal(variantContentHash(path), hash)
  writeFileSync(path, 'changed\n'); assert.notEqual(variantContentHash(path), hash)
  assert.equal(variantContentHash(join(dir, 'absent.ts')), null)
})
