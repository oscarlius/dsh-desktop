/** Native, credential-free update drill for the company macOS DMG. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { DEFAULT_P7_PUBLIC_ORIGIN } from 'dsh-plugin-p7-company-models/defaults'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const workspace = resolve(root, '..')
const productName = 'P7 DSH Company Test'
const publicOrigin = DEFAULT_P7_PUBLIC_ORIGIN
const updatePath = '/v1/desktop/releases/macos/latest'
const required = (value, description) => { if (!value) throw new Error(`Missing ${description}`); return value }
async function sha256(filename) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex') }
async function detach(mount) { await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30_000 }).catch(() => execute('/usr/bin/hdiutil', ['detach', '-force', mount], { timeout: 30_000 })) }
async function waitFor(description, predicate, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 250)) }
  throw new Error(`Timed out waiting for ${description}`)
}
async function updatedProcess(executable) {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,command='], { timeout: 10_000 })
  const line = stdout.split('\n').find(value => value.includes(executable) && value.includes('--updated'))
  if (!line) return undefined
  const pid = Number(line.trim().split(/\s+/u, 1)[0])
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined
}

async function helper() {
  const options = JSON.parse(required(process.argv[process.argv.indexOf('--helper') + 1], 'helper options'))
  const { createCompanyUpdateAdapter } = await import('../src/company-updates.ts')
  const { NextUpdateInstaller } = await import('../src/update-installer.ts')
  const rewrite = url => { const value = new URL(url); assert.equal(value.origin, publicOrigin, 'test transport only accepts canonical P7 URLs'); return new URL(`${value.pathname}${value.search}`, options.server).href }
  const request = async (url, init) => fetch(rewrite(url), init)
  const artifactRequest = async (url, init) => ({ response: await fetch(rewrite(url), init), finalUrl: url })
  const log = []
  const adapter = createCompanyUpdateAdapter({ platform: 'darwin', request, artifactRequest, log: value => log.push(String(value)) })
  const signal = new AbortController().signal
  const release = await adapter.check(options.currentVersion, signal)
  assert.equal(release.status, 'update-available')
  await mkdir(options.downloads, { recursive: true, mode: 0o700 })
  const downloaded = await adapter.download(release, options.downloads, signal, () => undefined)
  await adapter.verify(downloaded, release, signal)
  const installer = new NextUpdateInstaller({ platform: 'darwin', executable: options.executable, productName, log: value => log.push(String(value)) })
  await installer.prepare(downloaded, release.version, options.staging, signal)
  await installer.stage(); await installer.launch()
  await writeFile(options.result, JSON.stringify({ downloaded, release, log }) + '\n', { mode: 0o600 })
}

if (process.argv.includes('--helper')) { await helper(); process.exit(0) }
if (process.platform !== 'darwin') throw new Error('Company macOS upgrade smoke requires a native macOS host')

const dist = resolve(process.argv[2] ?? join(root, 'dist', 'mac-smoke'))
const dmgs = (await execute('/usr/bin/find', [dist, '-maxdepth', '1', '-type', 'f', '-name', '*.dmg', '-print'])).stdout.split('\n').map(value => value.trim()).filter(Boolean)
assert.equal(dmgs.length, 1, `expected exactly one DMG in ${relative(workspace, dist) || dist}`)
const dmg = dmgs[0]
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
// The test starts from a copied instance of the exact output DMG. It proves the
// native replacement/relaunch path, not a claim that an older production build
// was upgraded. The lower control-plane version only permits that isolated swap.
const currentVersion = '0.0.0'
const filename = `P7-DSH-Company-Test-${version}-universal.dmg`
const artifactPath = `/ui/downloads/dsh/companytest-mac/${version}/${filename}`
const temporary = await mkdtemp(join(tmpdir(), 'p7-dsh-company-mac-upgrade-'))
const mount = join(temporary, 'mounted'), installed = join(temporary, 'Applications', `${productName}.app`), home = join(temporary, 'home'), companyHome = join(temporary, 'dsh-home'), userData = join(home, 'Library', 'Application Support', productName), result = join(temporary, 'result.json')
let server; let launchedPid
try {
  await mkdir(mount, { mode: 0o700 }); await mkdir(dirname(installed), { recursive: true, mode: 0o700 })
  await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], { timeout: 120_000 })
  try {
    const apps = (await execute('/usr/bin/find', [mount, '-maxdepth', '1', '-type', 'd', '-name', '*.app', '-print'])).stdout.split('\n').map(value => value.trim()).filter(Boolean)
    assert.equal(apps.length, 1, 'the smoke DMG must contain exactly one application bundle')
    // ditto preserves the relative symlinks inside Electron framework bundles.
    await execute('/usr/bin/ditto', [apps[0], installed], { timeout: 5 * 60_000 })
  } finally { await detach(mount) }
  const before = await lstat(installed)
  // These are the actual Company home and Electron user-data roots selected by
  // the launch environment, rather than unrelated temporary marker files.
  await mkdir(join(companyHome, 'profiles', 'default'), { recursive: true, mode: 0o700 }); await mkdir(userData, { recursive: true, mode: 0o700 })
  const markers = { profile: join(companyHome, 'profiles', 'default', 'profile.json'), chat: join(companyHome, 'profiles', 'default', 'chat-history.jsonl'), simulatedAuth: join(userData, 'simulated-auth-token.json') }
  await writeFile(markers.profile, '{"profile":"company-smoke"}\n', { mode: 0o600 }); await writeFile(markers.chat, '{"message":"preserve me"}\n', { mode: 0o600 }); await writeFile(markers.simulatedAuth, '{"kind":"simulated-only","token":"not-a-live-login"}\n', { mode: 0o600 })
  const digest = await sha256(dmg), size = (await lstat(dmg)).size, requests = []
  server = createServer(async (request, response) => {
    requests.push(request.url)
    if (request.url === updatePath) { response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ channel: 'companytest', platform: 'darwin', architecture: 'universal', published: true, version, releaseNotes: 'isolated native macOS upgrade smoke', downloadUrl: `${publicOrigin}${artifactPath}`, sha256: digest, size })); return }
    if (request.url === artifactPath) { response.writeHead(200, { 'content-type': 'application/x-apple-diskimage', 'content-length': String(size) }); await pipeline(createReadStream(dmg), response); return }
    response.writeHead(404).end()
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const executable = join(installed, 'Contents', 'MacOS', productName)
  const staging = join(temporary, 'staging'); await mkdir(staging, { recursive: true, mode: 0o700 })
  const options = { server: `http://127.0.0.1:${address.port}`, downloads: join(temporary, 'downloads'), staging, executable, result, currentVersion }
  await execute(process.execPath, ['--experimental-transform-types', fileURLToPath(import.meta.url), '--helper', JSON.stringify(options)], { env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', HOME: home, CFFIXED_USER_HOME: home, DSH_DESKTOP_NEXT_HOME: companyHome }, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 })
  const outcome = JSON.parse(await readFile(result, 'utf8'))
  assert.equal(outcome.release.version, version); assert.ok(requests.includes(updatePath), 'the P7 metadata endpoint was not requested through isolated transport'); assert.ok(requests.includes(artifactPath), 'the produced DMG was not downloaded through isolated transport')
  await waitFor('the staged bundle to replace the temporary installed bundle', async () => (await lstat(installed)).ino !== before.ino)
  assert.match(await readFile(markers.profile, 'utf8'), /company-smoke/); assert.match(await readFile(markers.chat, 'utf8'), /preserve me/); assert.match(await readFile(markers.simulatedAuth, 'utf8'), /simulated-only/)
  // The application schedules its background update query after 30 seconds.
  // Observing and terminating this clean, empty-profile launch within 20 seconds
  // keeps the UI proof off the public update service as well.
  await waitFor('the updated application launch', async () => { launchedPid = await updatedProcess(executable); return launchedPid !== undefined }, 20_000)
  console.log(JSON.stringify({ smoke: 'company-mac-upgrade', result: 'passed', source: 'isolated-local-p7-transport', replacement: 'temporary same-bundle app copy replaced', relaunch: '--updated observed in native process list; renderer readiness is not asserted', data: 'Company-home profile/chat and user-data simulated-auth markers preserved; no live Feishu login' }))
} finally {
  if (launchedPid !== undefined) process.kill(launchedPid, 'SIGTERM')
  if (server !== undefined) await new Promise(resolve => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
