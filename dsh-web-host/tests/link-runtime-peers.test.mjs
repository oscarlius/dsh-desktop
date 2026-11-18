import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { linkRuntimePeers } from '../scripts/link-runtime-peers.mjs'

const peer = '@deepseek-ai/dsh-credentials'
async function fixture({ source = true, foreign = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'p7-runtime-peers-'))
  const web = join(root, 'dsh-web-host'), business = join(root, 'dsh-plugin-p7-mcp')
  await mkdir(join(web, 'node_modules', '@deepseek-ai'), { recursive: true })
  await mkdir(join(business, 'lib'), { recursive: true })
  await writeFile(join(web, 'package.json'), '{"name":"dsh-web-host"}')
  await writeFile(join(business, 'package.json'), JSON.stringify({ name: 'dsh-plugin-p7-mcp', peerDependencies: { [peer]: '0.2.2-rc.1' } }))
  await writeFile(join(business, 'lib', 'index.cjs'), `module.exports=require(${JSON.stringify(peer)})`)
  if (source) {
    const packageDir = join(web, 'node_modules', '@deepseek-ai', 'dsh-credentials')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: peer, main: 'index.cjs' }))
    await writeFile(join(packageDir, 'index.cjs'), 'module.exports={resolved:true}')
  }
  if (foreign) {
    const packageDir = join(root, 'foreign')
    await mkdir(packageDir)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: peer }))
    await mkdir(join(business, 'node_modules', '@deepseek-ai'), { recursive: true })
    await (await import('node:fs/promises')).symlink(packageDir, join(business, 'node_modules', peer), process.platform === 'win32' ? 'junction' : 'dir')
  }
  return { root, web, business }
}

test('links declared peers from WebHost closure and makes them require-resolvable', async t => {
  const value = await fixture(); t.after(() => rm(value.root, { recursive: true, force: true }))
  await linkRuntimePeers({ webHostDir: value.web, businessDirs: [value.business] })
  assert.deepEqual(createRequire(join(value.business, 'lib', 'index.cjs'))(peer), { resolved: true })
  const first = await readlink(join(value.business, 'node_modules', peer)); assert.ok(first)
  await linkRuntimePeers({ webHostDir: value.web, businessDirs: [value.business] })
})

test('fails closed when the WebHost closure is missing a declared peer', async t => {
  const value = await fixture({ source: false }); t.after(() => rm(value.root, { recursive: true, force: true }))
  await assert.rejects(linkRuntimePeers({ webHostDir: value.web, businessDirs: [value.business] }), /missing WebHost closure peer/)
})

test('never replaces a foreign existing peer target', async t => {
  const value = await fixture({ foreign: true }); t.after(() => rm(value.root, { recursive: true, force: true }))
  await assert.rejects(linkRuntimePeers({ webHostDir: value.web, businessDirs: [value.business] }), /refusing to replace foreign/)
})
