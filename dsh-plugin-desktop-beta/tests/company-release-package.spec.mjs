import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseManifest } from '../scripts/package-company-release.mjs'

describe('company release manifest', () => {
  let output
  after(() => rmSync(output, { recursive: true, force: true }))

  it('publishes exactly the Full installer, update installer, and update blockmap', () => {
    output = mkdtempSync(join(tmpdir(), 'dsh-company-release-'))
    mkdirSync(join(output, 'full'))
    mkdirSync(join(output, 'update'))
    writeFileSync(join(output, 'full', 'P7-DSH-Company-Full-2.0.20-beta.15-x64-Setup.exe'), 'full')
    writeFileSync(join(output, 'update', 'P7-DSH-Company-Test-2.0.20-beta.15-x64-Setup.exe'), 'update')
    writeFileSync(join(output, 'update', 'P7-DSH-Company-Test-2.0.20-beta.15-x64-Setup.exe.blockmap'), 'blockmap')
    const manifest = releaseManifest('2.0.20-beta.15', 'a'.repeat(40), output)
    assert.equal(manifest.displayVersion, '2.0.18-beta.15')
    assert.equal(manifest.build, '2026102601')
    assert.deepEqual(manifest.artifacts.map(value => [value.component, value.path]), [
      ['initial-exe', 'full/P7-DSH-Company-Full-2.0.20-beta.15-x64-Setup.exe'],
      ['exe', 'update/P7-DSH-Company-Test-2.0.20-beta.15-x64-Setup.exe'],
      ['blockmap', 'update/P7-DSH-Company-Test-2.0.20-beta.15-x64-Setup.exe.blockmap'],
    ])
    for (const item of manifest.artifacts) {
      assert.match(item.sha256, /^[a-f0-9]{64}$/u)
      assert.ok(item.size > 0)
      assert.ok(item.sha512.length > 0)
    }
  })
})
