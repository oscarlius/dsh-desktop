import { lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUSINESS_PACKAGES = ['dsh-plugin-p7-mcp', 'dsh-plugin-p7-company-models', 'dsh-plugin-p7-web-search']
const DEEPSEEK_SCOPE = '@deepseek-ai'

const exists = async path => {
  try { return await lstat(path) } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
}
const inside = (root, path) => relative(root, path) !== '' && !relative(root, path).startsWith('..') && !relative(root, path).includes(':')
const manifest = async path => JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))

async function verifiedSource(webHostNodeModules, peer) {
  const closure = await realpath(webHostNodeModules)
  const source = join(webHostNodeModules, peer)
  const resolved = await realpath(source).catch(() => { throw new Error(`missing WebHost closure peer ${peer}`) })
  if (!inside(closure, resolved)) throw new Error(`peer ${peer} escapes the reviewed WebHost node_modules closure`)
  if ((await manifest(resolved)).name !== peer) throw new Error(`peer package name mismatch for ${peer}`)
  return resolved
}

async function linkPeer(target, source) {
  const current = await exists(target)
  if (current) {
    const resolved = await realpath(target).catch(() => { throw new Error(`existing peer target is unreadable: ${target}`) })
    if (resolved === source) return
    throw new Error(`refusing to replace foreign peer target: ${target}`)
  }
  await mkdir(dirname(target), { recursive: true })
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
}

export async function linkRuntimePeers({ webHostDir, businessDirs = BUSINESS_PACKAGES.map(name => join(dirname(webHostDir), name)) }) {
  const webHostNodeModules = join(webHostDir, 'node_modules')
  await realpath(webHostNodeModules).catch(() => { throw new Error('missing WebHost production node_modules closure') })
  for (const businessDir of businessDirs) {
    const business = await manifest(businessDir)
    for (const peer of Object.keys(business.peerDependencies ?? {}).filter(name => name.startsWith(`${DEEPSEEK_SCOPE}/`))) {
      const source = await verifiedSource(webHostNodeModules, peer)
      await linkPeer(join(businessDir, 'node_modules', peer), source)
    }
  }
}

export function defaultRuntimeLayout(scriptUrl = import.meta.url) {
  const webHostDir = dirname(dirname(fileURLToPath(scriptUrl)))
  return { webHostDir, businessDirs: BUSINESS_PACKAGES.map(name => join(dirname(webHostDir), name)) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await linkRuntimePeers(defaultRuntimeLayout())
