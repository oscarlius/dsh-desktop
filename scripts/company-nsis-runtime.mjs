/** Keep the upstream compiler/plugins and replace only reviewed installer stubs. */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'vendor', 'nsis-temp-runtime')
const require = createRequire(join(root, 'dsh-plugin-desktop-beta', 'package.json'))
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

export async function prepareCompanyNsisRuntime(destination, options = {}) {
  const source = options.vendorDirectory ?? vendor
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
  if (manifest.source?.tag !== 'v312' || !Array.isArray(manifest.stubs) || manifest.stubs.length === 0) {
    throw new Error('Company installer requires the reviewed NSIS 3.12 temp-runtime manifest')
  }
  if (!manifest.stubs.some(entry => entry.path === 'windows/Stubs/zlib-x86-unicode')) {
    throw new Error('Company installer is missing its Unicode zlib startup stub')
  }
  if (manifest.patch && sha256(join(source, manifest.patch.path)) !== manifest.patch.sha256) {
    throw new Error('NSIS source patch does not match its committed hash')
  }
  for (const entry of manifest.stubs) {
    if (!/^windows\/Stubs\/(?:zlib|bzip2|lzma)(?:_solid)?-x86-unicode$/u.test(entry.path)
      || sha256(join(source, entry.path)) !== entry.sha256) {
      throw new Error('Company NSIS startup stub does not match its committed hash')
    }
  }
  const { downloadBuilderToolset } = require('app-builder-lib/out/util/electronGet.js')
  const bundle = options.bundleDirectory ?? await downloadBuilderToolset({
    releaseName: 'nsis@1.2.1', filenameWithExt: 'nsis-bundle-3.12.tar.gz',
    checksums: { 'nsis-bundle-3.12.tar.gz': '56997fdefe25e7928a1a68b4583d08b240b66cf660234053b20131a74cc082f4' },
  })
  if (existsSync(destination)) throw new Error('NSIS preparation output already exists')
  mkdirSync(destination, { recursive: true })
  cpSync(bundle, destination, { recursive: true })
  for (const entry of manifest.stubs) {
    // Copy the reviewed bytes directly: replacing existing extensionless PE
    // files with fs.cpSync can unlink the destination before failing on Windows.
    writeFileSync(join(destination, entry.path), readFileSync(join(source, entry.path)))
    if (sha256(join(destination, entry.path)) !== entry.sha256) throw new Error('Prepared NSIS stub hash mismatch')
  }
  const provenance = { baseToolset: 'nsis@1.2.1', source: manifest.source,
    patchSha256: manifest.patch?.sha256 ?? manifest.patchSha256, manifestSha256: sha256(join(source, 'manifest.json')), stubs: manifest.stubs }
  writeFileSync(join(destination, 'company-temp-runtime.json'), JSON.stringify(provenance, null, 2) + '\n')
  return { directory: destination, provenance }
}
