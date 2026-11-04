import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sha512 = value => createHash('sha512').update(value).digest('base64')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
const isDsh = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const paths = [
  'dsh-plugin-desktop-beta/package.json', 'dsh-desktop-next/package.json',
  'dsh-community-market/package.json', 'dsh-plugin-p7-mcp/package.json',
  'dsh-plugin-p7-company-models/package.json', 'dsh-plugin-p7-web-search/package.json',
]
const filename = (name, version) => `${name.slice(1).replace('/', '-')}-${version}.tgz`
const selector = (name, range = '0.2.2-rc.1') => `${name}@npm:${range}`

export async function syncNpmVendoredRuntime({ mode, channel, upstreamDocument, upstream }) {
  if (mode !== '--write' && mode !== '--check') throw new Error('invalid mode')
  const source = upstream.releaseSource
  if (!source || source.kind !== 'npm') throw new Error('npm source metadata is required')
  const version = upstream.sourceVersion
  if (source.registry !== 'https://registry.npmjs.org' || source.version !== version) throw new Error('unsafe npm source metadata')
  const directory = join(root, 'vendor', 'dsh-runtime', version)
  const manifestPath = join(directory, 'manifest.json')
  const names = new Set()
  for (const path of paths) {
    const pkg = readJson(join(root, path))
    for (const field of fields) for (const name of Object.keys(pkg[field] ?? {})) if (isDsh(name)) names.add(name)
  }
  // Several compatibility fixes target transitive runtime modules. They must
  // receive the same official-byte provenance and active patch resolutions.
  for (const patch of readdirSync(join(root, 'patches'))) {
    if (patch.startsWith('dsh') && patch.endsWith(`@${version}.patch`)) names.add(`@deepseek-ai/${patch.slice(0, -`@${version}.patch`.length)}`)
  }
  if (mode === '--write') {
    mkdirSync(directory, { recursive: true })
    const fetchPackage = async name => {
      const metaResponse = await fetch(`${source.registry}/${encodeURIComponent(name)}/${version}`)
      if (!metaResponse.ok) throw new Error(`npm metadata unavailable for ${name}@${version}: ${metaResponse.status}`)
      const meta = await metaResponse.json()
      if (meta.name !== name || meta.version !== version || !meta.dist?.integrity?.startsWith('sha512-')) throw new Error(`invalid npm metadata for ${name}`)
      const tarball = meta.dist.tarball
      if (!tarball.startsWith(`${source.registry}/`)) throw new Error(`non-official tarball for ${name}`)
      const response = await fetch(tarball)
      if (!response.ok) throw new Error(`npm tarball unavailable for ${name}: ${response.status}`)
      const content = Buffer.from(await response.arrayBuffer())
      if (`sha512-${sha512(content)}` !== meta.dist.integrity) throw new Error(`integrity mismatch for ${name}`)
      const target = join(directory, filename(name, version))
      writeFileSync(target, content)
      return { name, version, filename: filename(name, version), size: content.length, sha256: sha256(target), integrity: meta.dist.integrity, tarball }
    }
    const packages = []
    const pending = [...names].sort()
    while (pending.length) packages.push(...await Promise.all(pending.splice(0, 16).map(fetchPackage)))
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.name !== 'manifest.json' && !packages.some(pkg => pkg.filename === entry.name)) rmSync(join(directory, entry.name), { force: true })
    writeJson(manifestPath, { formatVersion: 2, source, repository: upstreamDocument.repository, commit: upstream.commit, version, buildProfile: 'npm-registry', packages })
    const workspacePath = join(root, 'package.json')
    const workspace = readJson(workspacePath)
    workspace.resolutions ??= {}
    for (const entry of packages) {
      const fileTarget = `file:vendor/dsh-runtime/${version}/${entry.filename}`
      const patch = `patches/${entry.name.slice('@deepseek-ai/'.length)}@${version}.patch`
      const target = existsSync(join(root, patch))
        ? `patch:${entry.name}@${fileTarget.replace(':', '%3A')}#./${patch}`
        : fileTarget
      workspace.resolutions[selector(entry.name, version)] = target
      workspace.resolutions[selector(entry.name, `^${version}`)] = target
    }
    writeJson(workspacePath, workspace)
  }
  if (!existsSync(manifestPath)) throw new Error(`missing ${manifestPath}`)
  const manifest = readJson(manifestPath)
  if (manifest.formatVersion !== 2 || manifest.version !== version || manifest.buildProfile !== 'npm-registry' || JSON.stringify(manifest.source) !== JSON.stringify(source)) throw new Error('npm manifest provenance mismatch')
  if (source.package !== '@deepseek-ai/dsh' || manifest.packages.find(entry => entry.name === source.package)?.integrity !== source.integrity) throw new Error('npm release anchor integrity mismatch')
  if (manifest.packages.length !== names.size) throw new Error('npm manifest package count mismatch')
  for (const entry of manifest.packages) {
    const path = join(directory, entry.filename)
    if (!names.has(entry.name) || !existsSync(path) || statSync(path).size !== entry.size || sha256(path) !== entry.sha256 || !entry.integrity?.startsWith('sha512-') || `sha512-${sha512(readFileSync(path))}` !== entry.integrity) throw new Error(`npm vendored integrity mismatch for ${entry.name}`)
  }
  process.stdout.write(`sync-vendored-runtime: ${channel} ${manifest.packages.length} official npm packages verified\n`)
}
