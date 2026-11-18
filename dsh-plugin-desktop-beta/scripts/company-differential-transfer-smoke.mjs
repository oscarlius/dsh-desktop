#!/usr/bin/env node
/*
 * Runs electron-updater's real NSIS differential downloader against an isolated
 * cache.  It never installs an EXE or starts Electron; the companion PowerShell
 * smoke owns that lifecycle coverage.
 *
 * Example (the backend supplies the company-shaped metadata/feed):
 * node --experimental-strip-types scripts/company-differential-transfer-smoke.mjs \
 *   --BaseInstaller C:\\artifacts\\base.exe --CandidateInstaller C:\\artifacts\\candidate.exe \
 *   --CurrentVersion 2.0.18-beta.3 --CandidateVersion 2.0.18-beta.4 \
 *   --ServerUrl http://127.0.0.1:18090 --CacheRoot C:\\temp\\company-delta \
 *   --Scenario normal --ReportPath C:\\temp\\company-delta-report.json
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { CancellationToken, configureRequestOptions, configureRequestUrl, HttpExecutor } from 'builder-util-runtime'
import { NsisUpdater } from 'electron-updater'
import yaml from 'js-yaml'

const PUBLIC_ORIGIN = 'https://maas.zxrc.com.cn:8090'
const FEED_URL = `${PUBLIC_ORIGIN}/v1/desktop/releases/companytest/`
const CACHE_NAME = 'test-updater'
const SCENARIOS = new Set(['normal', 'missing-blockmap', 'range-failure', 'corrupt-cache'])

function usage() {
  return `Usage: node --experimental-strip-types ${basename(process.argv[1])} --BaseInstaller <base.exe> --CandidateInstaller <candidate.exe> --CurrentVersion <base semver> --CandidateVersion <candidate semver> --ServerUrl <http://127.0.0.1:port> --CacheRoot <isolated directory> --Scenario <${[...SCENARIOS].join('|')}> --ReportPath <report.json> [--BaseBlockmap <base.exe.blockmap>] [--ServerCa <certificate.pem>]`
}

function argumentsFrom(argv) {
  const result = Object.create(null)
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const name = arg.slice(2)
    if (name === 'help') { result.help = true; continue }
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`)
    result[name] = value
  }
  return result
}

function requireArgument(args, name) {
  if (typeof args[name] !== 'string' || args[name].length === 0) throw new Error(`--${name} is required`)
  return args[name]
}

async function sha256(path) {
  const digest = createHash('sha256')
  await new Promise((resolve, reject) => createReadStream(path).on('error', reject).on('end', resolve).pipe(digest))
  return digest.digest('hex')
}

async function sha512(path) {
  const digest = createHash('sha512')
  await new Promise((resolve, reject) => createReadStream(path).on('error', reject).on('end', resolve).pipe(digest))
  return digest.digest('base64')
}

function assertCompanyUrl(url) {
  if (url.origin !== PUBLIC_ORIGIN || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`Updater attempted a non-company URL: ${url.href}`)
  }
}

/**
 * Node's HTTP client is used only because this harness has no Electron runtime.
 * It maps the fixed public company origin to the test router while preserving
 * the URLs seen by electron-updater and the production manifest assertion.
 */
class LocalCompanyHttpExecutor extends HttpExecutor {
  constructor(serverUrl, scenario, requests, serverCa) {
    super()
    this.serverUrl = new URL(serverUrl)
    this.scenario = scenario
    this.requests = requests
    this.serverCa = serverCa
  }

  createRequest(options, callback) {
    const original = new URL(`${options.protocol ?? 'https:'}//${options.hostname}${options.port ? `:${options.port}` : ''}${options.path ?? '/'}`)
    assertCompanyUrl(original)
    const range = options.headers?.range
    const isBlockmap = original.pathname.endsWith('.blockmap')
    const shouldFail = (this.scenario === 'missing-blockmap' && isBlockmap) || (this.scenario === 'range-failure' && typeof range === 'string')
    const target = shouldFail
      ? new URL('/__company-differential-harness__/forced-failure', this.serverUrl)
      : new URL(`${original.pathname}${original.search}`, this.serverUrl)
    const headers = { ...(options.headers ?? {}), host: new URL(PUBLIC_ORIGIN).host }
    const requestEntry = {
      originalUrl: original.href,
      mappedUrl: target.href,
      requestHeaders: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])),
      responseStatus: null,
      responseBytes: 0,
      forcedFailure: shouldFail,
    }
    this.requests.push(requestEntry)
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers,
      // Electron owns the production request lifecycle. This Node-only harness
      // must not reuse Node 24 pooled sockets with stale completed-request timeouts.
      agent: false,
      timeout: options.timeout,
      ...(target.protocol === 'https:' && this.serverCa !== undefined ? { ca: this.serverCa, servername: 'maas.zxrc.com.cn' } : {}),
    }, response => {
      requestEntry.responseStatus = response.statusCode ?? null
      response.on('data', chunk => { requestEntry.responseBytes += Buffer.byteLength(chunk) })
      callback(response)
    })
    return request
  }

  /** Mirror ElectronHttpExecutor.download while retaining Node's real stream path. */
  async download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers ?? undefined, redirect: 'manual' }
      configureRequestUrl(url, requestOptions)
      configureRequestOptions(requestOptions)
      this.doDownload(requestOptions, {
        destination,
        options,
        onCancel,
        responseHandler: null,
        callback: error => error == null ? resolve(destination) : reject(error),
      }, 0)
    })
  }
}

function isolatedAppAdapter(root, version) {
  return {
    version,
    name: 'P7 DSH Company Test',
    isPackaged: true,
    appUpdateConfigPath: join(root, 'app-update.yml'),
    userDataPath: join(root, 'user-data'),
    baseCachePath: join(root, 'cache'),
    whenReady: async () => {},
    relaunch: () => { throw new Error('The transfer harness must not relaunch Electron') },
    quit: () => { throw new Error('The transfer harness must not quit Electron') },
    onQuit: () => {},
  }
}

async function mappedFetch(executor, publicUrl) {
  const data = await executor.downloadToBuffer(new URL(publicUrl), { cancellationToken: new CancellationToken() })
  return data
}

async function existingFile(path, label) {
  try { await access(path) } catch { throw new Error(`${label} does not exist: ${path}`) }
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${label} must be a file: ${path}`)
  return info
}

/** Return a byte in the old installer that GenericDifferentialDownloader will COPY. */
function reusedBlockOffset(oldBlockmapBytes, newBlockmapBytes) {
  const oldMap = JSON.parse(gunzipSync(oldBlockmapBytes).toString('utf8'))
  const newMap = JSON.parse(gunzipSync(newBlockmapBytes).toString('utf8'))
  if (!Array.isArray(oldMap.files) || !Array.isArray(newMap.files)) throw new Error('Blockmap does not contain files')
  const oldByName = new Map(oldMap.files.map(file => [file.name, file]))
  for (const newFile of newMap.files) {
    const oldFile = oldByName.get(newFile.name)
    if (!oldFile || !Array.isArray(oldFile.checksums) || !Array.isArray(oldFile.sizes) || !Array.isArray(newFile.checksums) || !Array.isArray(newFile.sizes)) continue
    const oldOffsets = new Map()
    let offset = oldFile.offset ?? 0
    for (let index = 0; index < oldFile.checksums.length; index += 1) {
      if (!oldOffsets.has(oldFile.checksums[index])) oldOffsets.set(oldFile.checksums[index], { offset, size: oldFile.sizes[index] })
      offset += oldFile.sizes[index]
    }
    for (let index = 0; index < newFile.checksums.length; index += 1) {
      const oldBlock = oldOffsets.get(newFile.checksums[index])
      if (oldBlock && oldBlock.size === newFile.sizes[index] && oldBlock.size > 0) return oldBlock.offset
    }
  }
  throw new Error('No reusable block was found; corrupt-cache cannot prove a reused-block fallback')
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  if (args.help) { console.log(usage()); return }
  for (const name of ['BaseInstaller', 'CandidateInstaller', 'CurrentVersion', 'CandidateVersion', 'ServerUrl', 'CacheRoot', 'Scenario', 'ReportPath']) requireArgument(args, name)
  if (!SCENARIOS.has(args.Scenario)) throw new Error(`Invalid --Scenario ${args.Scenario}; expected ${[...SCENARIOS].join(', ')}`)
  const server = new URL(args.ServerUrl)
  if (!['http:', 'https:'].includes(server.protocol)) throw new Error('--ServerUrl must be an HTTP(S) URL')
  if (server.username || server.password) throw new Error('--ServerUrl must not contain credentials')
  const serverCa = args.ServerCa === undefined ? undefined : await readFile(args.ServerCa)
  const baseSize = await existingFile(args.BaseInstaller, 'BaseInstaller')
  const candidateSize = await existingFile(args.CandidateInstaller, 'CandidateInstaller')
  if (candidateSize.size < 1 || baseSize.size < 1) throw new Error('Installers must not be empty')
  const cacheRoot = args.CacheRoot
  await rm(cacheRoot, { recursive: true, force: true })
  await mkdir(join(cacheRoot, 'cache', CACHE_NAME), { recursive: true })
  await mkdir(join(cacheRoot, 'user-data'), { recursive: true })
  await writeFile(join(cacheRoot, 'app-update.yml'), JSON.stringify({ updaterCacheDirName: CACHE_NAME }))

  const requests = []
  const logs = []
  const executor = new LocalCompanyHttpExecutor(server.href, args.Scenario, requests, serverCa)
  const manifest = yaml.load((await mappedFetch(executor, `${FEED_URL}latest.yml?noCache=1`)).toString())
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Company feed did not return an update manifest')
  const manifestFile = manifest.files?.[0]
  if (typeof manifestFile?.url !== 'string') throw new Error('Company manifest has no installer file')
  const candidatePublicUrl = new URL(manifestFile.url, FEED_URL)
  assertCompanyUrl(candidatePublicUrl)
  const suppliedCandidateHash = await sha256(args.CandidateInstaller)
  const candidateSha512 = await sha512(args.CandidateInstaller)
  const release = {
    status: 'update-available', version: args.CandidateVersion, releaseNotes: typeof manifest.releaseNotes === 'string' ? manifest.releaseNotes : '',
    downloadUrl: candidatePublicUrl.href, sha256: suppliedCandidateHash, updaterFeedUrl: FEED_URL, sha512: candidateSha512, size: candidateSize.size,
  }

  const stableCache = join(cacheRoot, 'cache', CACHE_NAME)
  await copyFile(args.BaseInstaller, join(stableCache, 'installer.exe'))
  let baseBlockmapUrl = args.BaseBlockmap
  if (baseBlockmapUrl === undefined) {
    baseBlockmapUrl = candidatePublicUrl.href.replaceAll(args.CandidateVersion, args.CurrentVersion) + '.blockmap'
  } else if (!new URL(baseBlockmapUrl).isAbsolute) {
    baseBlockmapUrl = new URL(baseBlockmapUrl, PUBLIC_ORIGIN).href
  }
  assertCompanyUrl(new URL(baseBlockmapUrl))
  // Seeding models the cache left by the base version. Fault scenarios begin
  // only when the candidate update itself asks the real downloader for data.
  const seedExecutor = new LocalCompanyHttpExecutor(server.href, 'normal', requests, serverCa)
  const seededBlockmap = await mappedFetch(seedExecutor, baseBlockmapUrl)
  if (seededBlockmap.length === 0) throw new Error('Base blockmap is empty')
  await writeFile(join(stableCache, 'current.blockmap'), seededBlockmap)
  let corruptedReusedByte = null
  if (args.Scenario === 'corrupt-cache') {
    const newBlockmap = await mappedFetch(seedExecutor, `${candidatePublicUrl.href}.blockmap`)
    const offset = reusedBlockOffset(seededBlockmap, newBlockmap)
    const cached = join(stableCache, 'installer.exe')
    const bytes = await readFile(cached)
    if (offset >= bytes.length) throw new Error(`Reusable block offset is outside BaseInstaller: ${offset}`)
    bytes[offset] ^= 0xff
    await writeFile(cached, bytes)
    corruptedReusedByte = offset
  }

  const adapter = isolatedAppAdapter(cacheRoot, args.CurrentVersion)
  // AppUpdater creates its GenericProvider when setFeedURL runs.  The isolated
  // AppAdapter deliberately starts with no Electron executor, so inject the
  // real Node executor before creating that provider.
  const updater = new NsisUpdater(null, adapter)
  updater.httpExecutor = executor
  updater.setFeedURL({ provider: 'generic', url: FEED_URL, channel: 'latest', useMultipleRangeRequest: false })
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'company-differential-update.ts')).href
  const { downloadCompanyDifferentialUpdate } = await import(moduleUrl)
  const downloadedInstaller = await downloadCompanyDifferentialUpdate({
    release,
    signal: new AbortController().signal,
    onProgress: () => {},
    log: message => logs.push(message),
    createUpdater: async () => updater,
  })
  const downloadedHash = await sha256(downloadedInstaller)
  if (downloadedHash !== suppliedCandidateHash) throw new Error('Downloaded installer SHA256 differs from CandidateInstaller')

  const installerRequests = requests.filter(entry => entry.originalUrl === candidatePublicUrl.href)
  const rangeRequests = installerRequests.filter(entry => /^bytes=/u.test(entry.requestHeaders.range ?? ''))
  const fullResponses = installerRequests.filter(entry => !entry.requestHeaders.range && entry.responseStatus === 200)
  const artifactBytes = installerRequests.reduce((total, entry) => total + entry.responseBytes, 0)
  const fallbackLog = logs.some(line => line.includes('Cannot download differentially, fallback to full download'))
  if (args.Scenario === 'normal') {
    if (rangeRequests.length === 0 || !rangeRequests.some(entry => entry.responseStatus === 206)) throw new Error('Normal differential transfer has no successful HTTP Range (206) evidence')
    if (artifactBytes >= candidateSize.size) throw new Error('Normal differential transfer downloaded a full installer or more')
  } else {
    if (!fallbackLog) throw new Error('Fallback scenario has no electron-updater differential failure evidence')
    if (fullResponses.length === 0 || !fullResponses.some(entry => entry.responseBytes >= candidateSize.size)) throw new Error('Fallback scenario has no successful full-installer HTTP 200 evidence')
  }
  const report = {
    success: true,
    scenario: args.Scenario,
    publicOrigin: PUBLIC_ORIGIN,
    serverUrl: server.href,
    actualAlgorithm: 'electron-updater@6.8.9 NsisUpdater -> GenericDifferentialDownloader; no mocked differential downloader',
    isolation: { root: cacheRoot, updaterCacheDirName: CACHE_NAME, appAdapter: 'isolated test AppAdapter', electronStarted: false, installerExecuted: false },
    base: { path: args.BaseInstaller, size: baseSize.size, sha256: await sha256(args.BaseInstaller), blockmap: baseBlockmapUrl },
    candidate: { path: args.CandidateInstaller, size: candidateSize.size, sha256: suppliedCandidateHash, sha512: candidateSha512, version: args.CandidateVersion },
    downloadedInstaller: { path: downloadedInstaller, sha256: downloadedHash, matchesCandidate: true },
    // Compatibility contract for company-differential-upgrade-smoke.ps1.
    fallbackForced: fallbackLog,
    entries: requests.map(({ requestHeaders, responseBytes, responseStatus, originalUrl, forcedFailure }) => ({ requestHeaders, responseBytes, responseStatus, originalUrl, forcedFailure })),
    transfer: { rangeRequestCount: rangeRequests.length, range206Count: rangeRequests.filter(entry => entry.responseStatus === 206).length, full200Count: fullResponses.length, actualArtifactBytes: artifactBytes, fullInstallerBytes: candidateSize.size, fallbackObserved: fallbackLog, corruptedReusedByte },
    requests,
    logs,
  }
  await mkdir(dirname(args.ReportPath), { recursive: true })
  await writeFile(args.ReportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report.transfer))
}

main().catch(error => {
  console.error(`company differential transfer smoke: ${error?.stack ?? error?.message ?? String(error)}`)
  process.exitCode = 1
})
