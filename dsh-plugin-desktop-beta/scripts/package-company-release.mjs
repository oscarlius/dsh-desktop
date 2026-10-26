/** Build matching protected initial and public differential company installers. */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { companyBuildVersion } from '../src/company-build-version.ts'

const packageRoot = resolve(dirname(fileURLToPath(new URL('../package.json', import.meta.url))))
const workspaceRoot = resolve(packageRoot, '..')
const VERSION = /^\d+\.\d+\.\d+-beta\.(?:0|[1-9]\d*)(?:\.build\.[1-9]\d*)?$/u
const COMMIT = /^[0-9a-f]{40}$/u

function command(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

function gitCommit() {
  for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
    const clean = spawnSync('git', args, { cwd: workspaceRoot })
    if (clean.error !== undefined || clean.status !== 0) {
      throw clean.error ?? new Error('Tracked source files must be committed before a company release')
    }
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' })
  const commit = result.stdout.trim()
  if (result.error !== undefined || result.status !== 0 || !COMMIT.test(commit)) {
    throw result.error ?? new Error('Unable to resolve the 40-character source Git commit')
  }
  return commit
}

export function releasePlan(environment = process.env) {
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('Invalid company release version')
  const output = resolve(environment.DSH_COMPANY_RELEASE_OUTPUT ?? join(packageRoot, 'dist-company', version))
  if (existsSync(output)) throw new Error(`Company release output already exists and will not be overwritten: ${output}`)
  return { version, output, staging: `${output}.staging-${randomUUID()}` }
}

function artifact(component, base, path) {
  const contents = readFileSync(join(base, path))
  return {
    component,
    path: path.replaceAll('\\', '/'),
    sha256: createHash('sha256').update(contents).digest('hex'),
    sha512: createHash('sha512').update(contents).digest('base64'),
    size: contents.length,
  }
}

export function releaseManifest(version, sourceCommit, output) {
  const product = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (product.version !== version) throw new Error('Release manifest version differs from its source package')
  const presentation = companyBuildVersion(version, product.dshCompanyCompatibilityBuild)
  const full = `full/P7-DSH-Company-Full-${version}-x64-Setup.exe`
  const update = `update/P7-DSH-Company-Test-${version}-x64-Setup.exe`
  const blockmap = `${update}.blockmap`
  return {
    schemaVersion: 1,
    channel: 'companytest',
    version,
    displayVersion: presentation.visible,
    build: presentation.build,
    sourceCommit,
    artifacts: [
      artifact('initial-exe', output, full),
      artifact('exe', output, update),
      artifact('blockmap', output, blockmap),
    ],
  }
}

function packageDistribution(staging, name, sourceCommit, updateDistribution) {
  const output = join(staging, name)
  const env = { ...process.env }
  // Clear caller state before defining this child distribution. In particular,
  // a caller's update flag must never turn the protected Full into a public one.
  delete env.DSH_COMPANY_UPDATE_DISTRIBUTION
  delete env.DSH_COMPANY_INITIAL_DISTRIBUTION
  Object.assign(env, {
    DSH_COMPANY_TEST_WINDOWS: '1',
    DSH_COMPANY_PACKAGE_OUTPUT: output,
    DSH_COMPANY_RELEASE_SOURCE_COMMIT: sourceCommit,
  })
  if (updateDistribution) env.DSH_COMPANY_UPDATE_DISTRIBUTION = '1'
  else env.DSH_COMPANY_INITIAL_DISTRIBUTION = '1'
  command(process.execPath, [join(packageRoot, 'scripts', 'package.ts'), 'company-win'], packageRoot, env)
}

export function runCompanyRelease() {
  const plan = releasePlan()
  const sourceCommit = gitCommit()
  mkdirSync(plan.staging, { recursive: true })
  try {
    // Each child receives an explicit distribution mode so an inherited update
    // environment cannot remove the protected bootstrap from the Full package.
    packageDistribution(plan.staging, 'full', sourceCommit, false)
    packageDistribution(plan.staging, 'update', sourceCommit, true)
    if (gitCommit() !== sourceCommit) throw new Error('Source Git commit changed during company package generation')
    const manifest = releaseManifest(plan.version, sourceCommit, plan.staging)
    const manifestPath = join(plan.staging, 'release-manifest.json')
    const temporaryManifest = `${manifestPath}.tmp`
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    renameSync(temporaryManifest, manifestPath)
    renameSync(plan.staging, plan.output)
    console.log(`Company Full and update release verified: ${plan.output}`)
  } catch (error) {
    rmSync(plan.staging, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCompanyRelease()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
