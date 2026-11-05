import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { prepareCompanyNsisRuntime } from './company-nsis-runtime.mjs'

test('company preparation patches a private toolchain copy and retains the upstream compiler/plugins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'company-nsis-runtime-test-'))
  try {
    const vendor = join(root, 'vendor'), base = join(root, 'base'), output = join(root, 'prepared')
    for (const path of [vendor, base]) mkdirSync(join(path, 'windows', 'Stubs'), { recursive: true })
    mkdirSync(join(base, 'windows', 'Plugins'))
    const stub = 'windows/Stubs/zlib-x86-unicode', content = 'reviewed startup runtime'
    writeFileSync(join(vendor, stub), content)
    writeFileSync(join(base, stub), 'original runtime')
    writeFileSync(join(base, 'windows', 'makensis.exe'), 'upstream compiler')
    writeFileSync(join(base, 'windows', 'Plugins', 'UAC.dll'), 'upstream plugin')
    writeFileSync(join(vendor, 'manifest.json'), JSON.stringify({ source: { tag: 'v312' },
      patchSha256: 'a'.repeat(64), stubs: [{ path: stub, sha256: createHash('sha256').update(content).digest('hex') }] }))
    const result = await prepareCompanyNsisRuntime(output, { vendorDirectory: vendor, bundleDirectory: base })
    assert.equal(result.directory, output)
    assert.equal(readFileSync(join(output, stub), 'utf8'), content)
    assert.equal(readFileSync(join(base, stub), 'utf8'), 'original runtime')
    for (const file of ['windows/makensis.exe', 'windows/Plugins/UAC.dll']) {
      assert.deepEqual(readFileSync(join(output, file)), readFileSync(join(base, file)))
    }
    writeFileSync(join(vendor, stub), 'unreviewed bytes')
    const refused = join(root, 'refused')
    await assert.rejects(prepareCompanyNsisRuntime(refused, { vendorDirectory: vendor, bundleDirectory: base }), /committed hash/)
    assert.equal(existsSync(refused), false)
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'company-nsis-runtime-test-')))
    rmSync(root, { recursive: true, force: true })
  }
})
