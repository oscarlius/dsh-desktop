/** Verify the internal test installer identity, unsigned state, hashes, and packaged runtime metadata. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const version = process.env.DSH_COMPANY_UPDATE_VERSION ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+-beta\.\d+$/u.test(version)) throw new Error('Invalid company update version')
const dist = join(root, 'dist')
const installer = join(dist, `P7-DSH-Company-Test-${version}-x64-Setup.exe`)
const application = join(dist, 'win-unpacked', 'P7 DSH Company Test.exe')
const manifest = join(dist, 'win-unpacked', 'resources', 'app', 'package.json')

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
  const blockmap = `${installer}.blockmap`
  if (!existsSync(blockmap) || statSync(blockmap).size === 0) throw new Error('Company update installer is missing its blockmap')
  console.log('Company update distribution includes its differential blockmap.')
}
const connection = JSON.parse(readFileSync(connectionPath, 'utf8'))
if (connection.origin !== 'https://maas.zxrc.com.cn:8090' || typeof connection.key !== 'string' || !/^p7k_[\x21-\x7e]+$/.test(connection.key)) throw new Error('The company connection resource is missing or invalid')
console.log('Company public gateway and dedicated connection resource verified (credential withheld).')
if (packaged.dshDesktopFlavor !== 'companytest') throw new Error('packaged runtime does not carry the companytest flavor marker')
if (packaged.dependencies?.['dsh-plugin-p7-company-models'] !== 'workspace:*') throw new Error('packaged runtime does not declare the bundled P7 dependency')
console.log(`Company test packaged runtime verified: ${manifest}`)
verifyPackagedRuntime()
