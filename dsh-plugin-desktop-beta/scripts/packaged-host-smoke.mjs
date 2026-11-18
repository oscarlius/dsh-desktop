/** Boot the real Host from one packaged Next archive and stop it; no window, no user data. */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { cleanupDisposableTree } from '../../dsh-plugin-desktop/src/disposable-tree.ts'

const BADGE_BUNDLE = '@deepseek-ai/dsh-experimental-badge-skill-bundle'
const root = process.argv[2]
if (!root) throw new Error('packaged-host-smoke: expected the packaged application root')
const { NextDesktopRuntime } = await import(pathToFileURL(join(root, 'lib', 'desktop-runtime.js')).href)
const home = mkdtempSync(join(tmpdir(), 'dsh-next-packaged-smoke-'))
let failures = 0
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const companyMode = manifest.dshDesktopFlavor === 'companytest'
let vaultLoads = 0
let externalBrowserRequests = 0
const policyFixtureHit = join(home, 'p7-policy-fixture-hit')

/**
 * The real Company broker checks its public policy before restoring the sealed
 * refresh store.  Keep this packaging check entirely local while preserving
 * that exact broker path: only that one policy request receives a fixture;
 * every other attempted network request is rejected.
 */
function installCompanyPolicyFixture() {
  if (!companyMode) return () => {}
  const fixture = join(home, 'p7-policy-fixture.cjs')
  writeFileSync(fixture, `
const origin = 'https://maas.zxrc.com.cn:8090'
const { writeFileSync } = require('node:fs')
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.origin === origin && url.pathname === '/api/v1/desktop-auth/policy') {
    writeFileSync(${JSON.stringify(policyFixtureHit)}, 'hit')
    return new Response(JSON.stringify({ upgradeRequired: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  throw new Error('Packaged Company smoke blocked unexpected network request: ' + url.origin)
}
`)
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = [previous, `--require=${fixture}`].filter(Boolean).join(' ')
  return () => {
    if (previous === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previous
  }
}

function hasCompanyBootInjections(injections) {
  const policy = injections.find(value => value && typeof value === 'object'
    && value.kind === 'global' && value.name === '__DSH_COMPANY_POLICY__')
  const transcript = injections.find(value => value && typeof value === 'object'
    && value.kind === 'script' && value.placement === 'head' && typeof value.text === 'string'
    && value.text.includes('dsh-streamfold'))
  if (transcript === undefined) return false
  const values = new Map()
  runInNewContext(transcript.text, { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  } })
  let settings
  try { settings = JSON.parse(values.get('dsh-streamfold')) } catch { return false }
  return policy?.value?.accountOnboardingEnabled === false && policy.value.requirePersonalLogin === true
    && settings?.windowHeight === 180 && settings.sparks === false && settings.forgeSparks === false
}

function assertCompanyProfile(profile) {
  const overlay = JSON.parse(readFileSync(join(profile, 'desktop-next.cordis.patch.json'), 'utf8'))
  const entries = overlay.flatMap(patch => patch.insert ?? [])
  for (const id of ['p7-company-models', 'p7-web-search', 'p7-managed-mcp']) {
    if (!entries.some(entry => entry.id === id)) throw new Error(`Packaged Company profile omitted required ${id} plugin`)
  }
  const models = entries.find(entry => entry.id === 'p7-company-models')
  if (models?.config?.requirePersonalLogin !== true) throw new Error('Packaged Company P7 models do not require a personal login')
}

const restoreNodeOptions = installCompanyPolicyFixture()
// The payload of this CPU sits beside the archive, where the packaged shell selects it.
const packagedRuntime = join(dirname(root), 'runtime', process.arch, 'primary-runtime')
const primaryRuntime = existsSync(packagedRuntime) ? packagedRuntime : join(root, '.desktop-build', 'runtime', process.arch, 'primary-runtime')
const runtime = new NextDesktopRuntime({ root, home, primaryRuntime, executable: process.execPath, addresses: () => [],
  certificate: async () => { throw new Error('The packaged smoke must not request system key storage or expose a LAN listener') },
  onFailure: () => { failures += 1 }, onChange() {}, onRestart() {}, onTerminal() {}, onNotification() {},
  ...(companyMode ? {
    companyMode: true,
    p7SessionVault: async (_profile, request) => {
      if (request.action === 'load') vaultLoads += 1
      return {}
    },
    onP7AccountBrowser: () => {
      externalBrowserRequests += 1
      throw new Error('Packaged Company smoke must not open an external browser')
    },
  } : {}),
})
try {
  runtime.initialize()
  runtime.profiles.ensure('desktop')
  // The Community Market bundle loads from the archive; remote control stays off because the
  // bridge shares its state directory with the user's other editions; the native computer-use
  // provider loads its library from the unpacked platform package when the Host activates it.
  runtime.profiles.finishOnboarding('desktop', { features: { market: true, remoteControl: false }, computerUse: true })
  if (!runtime.profiles.computerUseEnabled('desktop')) throw new Error('The smoke profile did not enable the native computer-use provider')
  // The badge skill bundle is off by default; enabled, the Host loads its provider from the unpacked copy through the resolver.
  const manifestPath = join(runtime.profiles.directory('desktop'), 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.dsh.profile.bundles.includes(BADGE_BUNDLE)) manifest.dsh.profile.bundles.push(BADGE_BUNDLE)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  await runtime.start()
  const state = runtime.state()
  if (state.phase !== 'ready' || failures !== 0) throw new Error(`Packaged Host did not reach ready: phase=${state.phase} failure=${state.failure}`)
  if (companyMode) {
    assertCompanyProfile(runtime.profiles.directory('desktop'))
    const deadline = Date.now() + 10_000
    while (vaultLoads === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    if (vaultLoads === 0) throw new Error('Packaged Company Host did not load the isolated P7 vault')
    if (!existsSync(policyFixtureHit)) throw new Error('Packaged Company Host did not use the local P7 policy fixture')
    if (externalBrowserRequests !== 0) throw new Error('Packaged Company Host requested an external browser during cold boot')
    const injections = await runtime.injections()
    if (!hasCompanyBootInjections(injections)) {
      const rows = injections.map(value => value && typeof value === 'object'
        ? { kind: value.kind, name: value.name, placement: value.placement, streamFold: typeof value.text === 'string' && value.text.includes('dsh-streamfold') }
        : { kind: typeof value })
      throw new Error(`Packaged Company Host omitted the sealed login policy or 180px StreamFold bootstrap: ${JSON.stringify(rows)}`)
    }
  }
  const auth = runtime.auth
  if (!auth) throw new Error('Packaged Host reported ready without native credentials')
  // Only the native capability passes the request gate; a bare loopback browser request is refused.
  const response = await fetch(new URL(auth.url).origin)
  if (response.status !== 403) throw new Error(`Packaged Host exposed the application to ordinary browsers: HTTP ${String(response.status)}`)
  await response.body?.cancel()
  // Diagnostics export runs a worker thread from the archive.
  const report = join(home, 'diagnostics.json')
  await runtime.diagnostics.exportTo(report, { ...state, platform: process.platform, version: 'smoke', updates: null, trayAvailable: false, notificationsAvailable: false, onboarding: false })
  if (!existsSync(report)) throw new Error('Packaged diagnostics export produced no file')
  // The loader reports optional plugins it could not activate on stderr, which the shell records.
  const inactive = runtime.diagnostics.snapshot().split('\n').filter(line => line.includes('did not activate'))
  if (inactive.length > 0) throw new Error(`Packaged Host left plugins inactive:\n${inactive.join('\n')}`)
  console.log(`Packaged Next Host booted from ${root}: profile ${state.selected}, loopback ${new URL(auth.url).origin}, diagnostics export ok`)
} finally {
  await runtime.close()
  restoreNodeOptions()
  cleanupDisposableTree(home)
}
