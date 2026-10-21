/** Validate the paired release, stage all artifacts, then atomically move the public feed. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync, realpathSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const P7_RELEASE_ORIGIN = 'https://maas.zxrc.com.cn:8090'
const components = ['initial-exe', 'exe', 'blockmap']
const endpoint = '/api/v1/model-admin/desktop-release'
const ensure = (condition, message) => { if (!condition) throw new Error(message) }
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const digest = async path => {
  const sha256 = createHash('sha256'), sha512 = createHash('sha512')
  for await (const chunk of createReadStream(path)) { sha256.update(chunk); sha512.update(chunk) }
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

export async function validateCompanyRelease(directory) {
  const root = realpathSync(resolve(directory)), manifest = json(join(root, 'release-manifest.json'))
  ensure(manifest.schemaVersion === 1 && manifest.channel === 'companytest', 'Unsupported company release manifest')
  ensure(/^\d+\.\d+\.\d+-beta\.(?:0|[1-9]\d*)(?:\.build\.[1-9]\d*)?$/.test(manifest.version), 'Invalid company release version')
  ensure(/^[0-9a-f]{40}$/.test(manifest.sourceCommit), 'Release must identify its committed source')
  ensure(Array.isArray(manifest.artifacts) && manifest.artifacts.length === 3, 'Full, update and blockmap must be supplied together')
  const artifacts = []
  for (const component of components) {
    const matches = manifest.artifacts.filter(item => item.component === component)
    ensure(matches.length === 1, `Missing or duplicate ${component}`)
    const item = matches[0]
    const name = component === 'initial-exe' ? `P7-DSH-Company-Full-${manifest.version}-x64-Setup.exe`
      : `P7-DSH-Company-Test-${manifest.version}-x64-Setup.exe${component === 'blockmap' ? '.blockmap' : ''}`
    ensure(item.path === `${component === 'initial-exe' ? 'full' : 'update'}/${name}`, `Wrong role or version filename for ${component}`)
    const path = realpathSync(join(root, item.path)), inside = relative(root, path)
    ensure(!isAbsolute(inside) && inside !== '..' && !inside.startsWith('../') && !inside.startsWith('..\\'), 'Artifact escaped the release directory')
    ensure(Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 1024 ** 3 && statSync(path).size === item.size, `Invalid artifact size for ${component}`)
    const hashes = await digest(path)
    ensure(hashes.sha256 === item.sha256 && hashes.sha512 === item.sha512, `Artifact hash mismatch for ${component}`)
    artifacts.push({ ...item, absolutePath: path })
  }
  ensure(artifacts[0].sha256 !== artifacts[1].sha256, 'Full and update cannot be the same installer')
  for (const kind of ['full', 'update']) {
    const resource = join(root, kind, 'win-unpacked', 'resources')
    const packaged = json(join(resource, 'app', 'package.json'))
    ensure(packaged.version === manifest.version && packaged.dshDesktopFlavor === 'companytest'
      && packaged.dshCompanyReleaseSourceCommit === manifest.sourceCommit, `Packaged ${kind} source/version mismatch`)
    const bootstrap = join(resource, 'p7-company-connection.json')
    if (kind === 'update') {
      ensure(packaged.dshDesktopUpdateDistribution === true && !existsSync(bootstrap), 'Public update must be credential-free')
    } else {
      ensure(packaged.dshDesktopUpdateDistribution !== true, 'Full was built as an update package')
      let value
      try { value = json(bootstrap) } catch { throw new Error('Full is missing a valid protected P7 bootstrap') }
      ensure(value.origin === P7_RELEASE_ORIGIN && typeof value.key === 'string' && /^p7k_[\x21-\x7e]+$/.test(value.key) && value.key.length <= 4096, 'Full is missing a valid protected P7 bootstrap')
    }
  }
  const blockmap = JSON.parse(gunzipSync(readFileSync(artifacts[2].absolutePath), { maxOutputLength: 32 * 1024 * 1024 }).toString())
  ensure(blockmap.version === '2' && Array.isArray(blockmap.files) && blockmap.files.length > 0, 'Invalid differential blockmap')
  let end = 0
  for (const file of blockmap.files) {
    ensure(file.offset === end && Array.isArray(file.sizes) && file.sizes.length > 0 && file.sizes.every(size => Number.isSafeInteger(size) && size > 0)
      && Array.isArray(file.checksums) && file.checksums.length === file.sizes.length, 'Invalid differential blockmap ranges')
    end += file.sizes.reduce((sum, size) => sum + size, 0)
  }
  ensure(end === artifacts[1].size, 'Differential blockmap does not cover the update installer')
  return { root, manifest, artifacts }
}

async function checked(response) {
  ensure(response.ok, `P7 release request failed (HTTP ${response.status})`)
  return response.json()
}

export async function publishCompanyRelease({ directory, token, notes, reason, stageOnly = false, fetchImpl = globalThis.fetch }) {
  // Complete local validation before any upload or public-state mutation.
  const bundle = await validateCompanyRelease(directory)
  ensure(typeof token === 'string' && token.trim(), 'A protected P7 administrator session is required')
  ensure(typeof reason === 'string' && reason.trim() && reason.length <= 2000, 'A release audit reason is required')
  ensure(typeof notes === 'string' && notes.trim() && notes.length <= 20000, 'Release notes are required')
  const { version } = bundle.manifest
  const headers = { Authorization: `Bearer ${token.trim()}`, 'X-Request-Id': randomUUID() }
  const call = (path, options = {}) => fetchImpl(P7_RELEASE_ORIGIN + endpoint + path, { ...options, redirect: 'error', headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(20 * 60 * 1000) })
  const before = await checked(await call(''))
  const staged = await checked(await call(`/readiness?version=${encodeURIComponent(version)}`))
  for (const artifact of bundle.artifacts) {
    const existing = staged.artifacts?.[artifact.component]
    if (existing?.available) {
      ensure(existing.sha256 === artifact.sha256 && existing.size === artifact.size, `Immutable server artifact differs: ${artifact.component}`)
      continue
    }
    const route = artifact.component === 'initial-exe' ? '/initial-installer' : artifact.component === 'blockmap' ? '/artifact/blockmap' : '/artifact'
    const saved = await checked(await call(`${route}?version=${encodeURIComponent(version)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(artifact.size), 'X-DSH-Artifact-Name': basename(artifact.path) },
      body: createReadStream(artifact.absolutePath), duplex: 'half',
    }))
    ensure(saved.version === version && saved.sha256 === artifact.sha256 && saved.size === artifact.size, `Server artifact readback mismatch: ${artifact.component}`)
  }
  const readiness = await checked(await call(`/readiness?version=${encodeURIComponent(version)}`))
  ensure(readiness.version === version && readiness.ready === true, 'P7 did not verify all three artifacts; current public release retained')
  for (const artifact of bundle.artifacts) {
    const saved = readiness.artifacts?.[artifact.component]
    ensure(saved?.sha256 === artifact.sha256 && saved.size === artifact.size, `Final server readback mismatch: ${artifact.component}`)
  }
  let published = before
  if (!stageOnly && !(before.published && before.version === version)) {
    published = await checked(await call('', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: before.revision, published: true, version, releaseNotes: notes, reason }) }))
  }
  const after = await checked(await call(''))
  ensure(stageOnly ? after.revision === before.revision && after.version === before.version : after.published && after.version === version
    && after.sha256 === bundle.artifacts[1].sha256 && after.blockmapSha256 === bundle.artifacts[2].sha256 && after.revision === published.revision,
  'Publication readback failed; do not distribute until verified')
  const receipt = { schemaVersion: 1, status: stageOnly ? 'staged' : 'published', version, sourceCommit: bundle.manifest.sourceCommit,
    revision: after.revision, artifacts: bundle.manifest.artifacts, verifiedAt: new Date().toISOString() }
  const receiptPath = join(bundle.root, 'publication-receipt.json'), temporary = receiptPath + '.' + randomUUID() + '.tmp'
  writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 }); renameSync(temporary, receiptPath)
  return receipt
}

async function main(args) {
  const options = new Map()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    ensure(['--bundle', '--notes-file', '--reason', '--stage-only', '--dry-run'].includes(flag) && !options.has(flag), 'Unknown or duplicate release option')
    if (flag === '--stage-only' || flag === '--dry-run') options.set(flag, true)
    else { ensure(typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), `Missing value for ${flag}`); options.set(flag, args[++i]) }
  }
  ensure(typeof options.get('--bundle') === 'string', 'Use --bundle <paired release directory> --notes-file <file> --reason <audit reason>')
  if (options.has('--dry-run')) {
    const value = await validateCompanyRelease(options.get('--bundle'))
    console.log(JSON.stringify({ status: 'locally-verified', version: value.manifest.version, artifacts: value.manifest.artifacts }))
    return
  }
  let token
  if (process.env.P7_ADMIN_TOKEN_FILE) token = readFileSync(process.env.P7_ADMIN_TOKEN_FILE, 'utf8').trim()
  else if (process.env.P7_BOOTSTRAP_PASSWORD_FILE) {
    const passphrase = readFileSync(process.env.P7_BOOTSTRAP_PASSWORD_FILE, 'utf8').trim()
    const login = await fetch(P7_RELEASE_ORIGIN + '/auth/bootstrap', { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }) })
    ensure(login.status === 204, 'P7 administrator authentication failed')
    const session = await checked(await fetch(P7_RELEASE_ORIGIN + '/auth/session', { method: 'POST', redirect: 'error', headers: { Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') } }))
    token = session.access_token
  }
  ensure(typeof options.get('--notes-file') === 'string', '--notes-file is required')
  const receipt = await publishCompanyRelease({ directory: options.get('--bundle'), token,
    notes: readFileSync(resolve(options.get('--notes-file')), 'utf8'), reason: options.get('--reason'), stageOnly: options.has('--stage-only') })
  console.log(JSON.stringify({ status: receipt.status, version: receipt.version, revision: receipt.revision }))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) } catch (error) { console.error(error instanceof Error ? error.message : 'Company release failed'); process.exitCode = 1 }
}
