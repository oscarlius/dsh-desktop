/** Verify the internal test installer identity, unsigned state, hashes, and packaged runtime metadata. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const version = process.env.DSH_COMPANY_UPDATE_VERSION ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+-beta\.\d+$/u.test(version)) throw new Error('Invalid company update version')
const dist = process.env.DSH_COMPANY_PACKAGE_OUTPUT ?? join(root, 'dist')
const updateDistribution = process.env.DSH_COMPANY_UPDATE_DISTRIBUTION === '1'
const initialDistribution = process.env.DSH_COMPANY_INITIAL_DISTRIBUTION === '1'
const installer = join(dist, initialDistribution
  ? `P7-DSH-Company-Full-${version}-x64-Setup.exe`
  : `P7-DSH-Company-Test-${version}-x64-Setup.exe`)
const application = join(dist, 'win-unpacked', 'P7 DSH Company Test.exe')
const manifest = join(dist, 'win-unpacked', 'resources', 'app', 'package.json')
const require = createRequire(import.meta.url)

function assertPortableExecutable(path, label) {
  if (!existsSync(path) || statSync(path).size < 68) throw new Error(`${label} is missing or empty: ${path}`)
  const bytes = readFileSync(path)
  if (bytes.subarray(0, 2).toString('ascii') !== 'MZ') throw new Error(`${label} has no PE header: ${path}`)
}

function signature(path) {
  const script = fileURLToPath(new URL('./company-test-windows-signature.ps1', import.meta.url))
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', path], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) throw result.error ?? new Error(result.stderr || 'Get-AuthenticodeSignature failed')
  return JSON.parse(result.stdout)
}

function findConnectionFiles(path) {
  const found = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) found.push(...findConnectionFiles(child))
    else if (entry.isFile() && entry.name === 'p7-company-connection.json') found.push(child)
  }
  return found
}

function resolveSevenZip() {
  if (process.env.DSH_7ZA_PATH !== undefined) {
    if (!existsSync(process.env.DSH_7ZA_PATH)) throw new Error('DSH_7ZA_PATH does not name an existing 7za executable')
    return process.env.DSH_7ZA_PATH
  }
  const { getCacheDirectory } = require('app-builder-lib/out/util/electronGet.js')
  const cache = getCacheDirectory({ allowEnvVarOverride: true })
  for (const entry of readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^7zip@/u.test(entry.name)) continue
    const root = join(cache, entry.name)
    for (const platform of readdirSync(root, { withFileTypes: true })) {
      const candidate = join(root, platform.name, 'bin', '7za.exe')
      if (platform.isDirectory() && existsSync(candidate)) return candidate
    }
  }
  throw new Error('electron-builder 7za cache is unavailable; set DSH_7ZA_PATH to a trusted 7za executable')
}

function extractEmbeddedArchives(sevenZip, path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      extractEmbeddedArchives(sevenZip, child)
    } else if (entry.isFile() && /\.7z$/iu.test(entry.name)) {
      const target = `${child}.contents`
      const result = spawnSync(sevenZip, ['x', '-y', child, `-o${target}`], { encoding: 'utf8' })
      if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
        throw result.error ?? new Error('Unable to inspect an embedded NSIS archive')
      }
      extractEmbeddedArchives(sevenZip, target)
    }
  }
}

/** Inspect the compressed NSIS payload as well as win-unpacked resources. */
function verifyInstallerPayload(expectConnection) {
  const sevenZip = resolveSevenZip()
  const extraction = mkdtempSync(join(tmpdir(), 'dsh-company-nsis-'))
  try {
    const result = spawnSync(sevenZip, ['x', '-y', installer, `-o${extraction}`], { encoding: 'utf8' })
    if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
      throw result.error ?? new Error(result.stderr || 'Unable to inspect company NSIS payload')
    }
    extractEmbeddedArchives(sevenZip, extraction)
    const files = findConnectionFiles(extraction)
    if (expectConnection) {
      if (files.length !== 1) throw new Error('Full installer must contain exactly one protected P7 connection resource')
      const connection = JSON.parse(readFileSync(files[0], 'utf8'))
      if (connection.origin !== 'https://maas.zxrc.com.cn:8090' || typeof connection.key !== 'string' || !/^p7k_[\x21-\x7e]+$/.test(connection.key)) {
        throw new Error('Full installer carries an invalid P7 connection resource')
      }
    } else if (files.length !== 0) {
      throw new Error('Public update installer must not contain a reusable P7 credential')
    }
  } finally {
    rmSync(extraction, { recursive: true, force: true })
  }
}

function verifyPackagedRuntime() {
  const program = [
    "import { readFileSync, readdirSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { pathToFileURL } from 'node:url'",
    "const app = join(process.resourcesPath, 'app')",
    "const identityName = readdirSync(join(app, 'lib')).find(name => /^product-identity-.*\\.js$/u.test(name))",
    "if (identityName === undefined) throw new Error('missing bundled product identity module')",
    "const identity = await import(pathToFileURL(join(app, 'lib', identityName)).href)",
    "const product = Object.values(identity).find(value => value && typeof value === 'object' && value.appId === 'ai.deepseek.dsh.desktop.companytest')",
    "if (!product) throw new Error('missing sealed company product identity')",
    "const p7 = await import(pathToFileURL(join(app, 'node_modules', 'dsh-plugin-p7-company-models', 'lib', 'index.js')).href)",
    "const value = { packageName: product.packageName, productName: product.productName, appId: product.appId, homeDirectoryName: product.homeDirectoryName, updatesEnabled: product.updatesEnabled, accountOnboardingEnabled: product.accountOnboardingEnabled, bundledP7: typeof p7.CompanyHost === 'function' }",
    "if (value.packageName !== JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).name || value.productName !== 'P7 DSH Company Test' || value.appId !== 'ai.deepseek.dsh.desktop.companytest' || value.homeDirectoryName !== '.p7-dsh-companytest' || value.updatesEnabled !== false || value.accountOnboardingEnabled !== false || !value.bundledP7) process.exitCode = 1",
    'console.log(JSON.stringify(value))',
  ].join('; ')
  const result = spawnSync(application, ['--input-type=module', '-e', program], {
    cwd: dirname(application),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  })
  if (result.error !== undefined || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || result.stdout || 'packaged Electron runtime smoke failed')
  }
  console.log(`Company test Electron runtime smoke: ${result.stdout.trim()}`)
}

for (const [path, label] of [[installer, 'Company test NSIS installer'], [application, 'Company test application']]) {
  assertPortableExecutable(path, label)
  const state = signature(path)
  if (state.status !== 'NotSigned') throw new Error(`${label} must be unsigned; received Authenticode status ${state.status}`)
  console.log(`${label}: sha256=${createHash('sha256').update(readFileSync(path)).digest('hex')} signature=${state.status}`)
}
const packaged = JSON.parse(readFileSync(manifest, 'utf8'))
const connectionPath = join(dist, 'win-unpacked', 'resources', 'p7-company-connection.json')
if (packaged.dshDesktopUpdateDistribution === true) {
  if (existsSync(connectionPath)) throw new Error('Public update packages must not carry a reusable P7 credential')
  const blockmap = `${installer}.blockmap`
  if (!existsSync(blockmap) || statSync(blockmap).size === 0) throw new Error('Company update installer is missing its blockmap')
  console.log('Company update distribution has no bundled credential and includes a differential blockmap.')
} else {
  const connection = JSON.parse(readFileSync(connectionPath, 'utf8'))
  if (connection.origin !== 'https://maas.zxrc.com.cn:8090' || typeof connection.key !== 'string' || !/^p7k_[\x21-\x7e]+$/.test(connection.key)) throw new Error('The company connection resource is missing or invalid')
  console.log('Company public gateway and dedicated connection resource verified (credential withheld).')
}
if (packaged.dshDesktopUpdateDistribution === true !== updateDistribution) {
  throw new Error('Company package distribution marker does not match the requested artifact')
}
const sourceCommit = process.env.DSH_COMPANY_RELEASE_SOURCE_COMMIT
if (sourceCommit !== undefined && packaged.dshCompanyReleaseSourceCommit !== sourceCommit) {
  throw new Error('Packaged company source commit marker does not match the release source')
}
if (packaged.dshDesktopFlavor !== 'companytest') throw new Error('packaged runtime does not carry the companytest flavor marker')
if (packaged.dependencies?.['dsh-plugin-p7-company-models'] !== 'workspace:*') throw new Error('packaged runtime does not declare the bundled P7 dependency')
console.log(`Company test packaged runtime verified: ${manifest}`)
verifyPackagedRuntime()
verifyInstallerPayload(!updateDistribution)
