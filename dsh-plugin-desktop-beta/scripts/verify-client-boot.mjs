/** Boot the actual official frontend + Desktop factory in an isolated Host, with no model calls. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { DesktopHostProcess } from '../lib/host-process.js'
import { NextProfiles } from '../lib/profiles.js'
import { DEFAULT_PREFERENCES } from '../src/desktop-contract.ts'
import { authenticateWebHost, serveWebDocument } from '../lib/web-document.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const home = mkdtempSync(join(tmpdir(), 'dsh-client-boot-'))
const output = process.env.DSH_CLIENT_BOOT_REPORT ?? join(root, '.desktop-next/verification/client-boot')
mkdirSync(output, { recursive: true })
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const profiles = new NextProfiles(home)
const profile = profiles.ensure('desktop')
const entry = join(home, 'isolated-client-host.mjs')
writeFileSync(entry, `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin === 'https://maas.zxrc.com.cn:8090' && url.pathname === '/api/v1/desktop-auth/policy') return Promise.resolve(Response.json({upgradeRequired:false}));
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw Error('Client boot fixture blocks external egress');
  return nativeFetch(input, init);
};
await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/fixtures/isolated-user-host.mjs')).href)});
`)
const host = new DesktopHostProcess(process.execPath, root, profile, undefined,
  { ...process.env, DSH_HOME: home, DSH_COMPANY_MODE: '1', DSH_COMPANY_TRANSPORT_VERSION: manifest.version, DSH_TELEMETRY_DISABLED: '1' },
  undefined, join(root, '.desktop-build/runtime/x64/primary-runtime'), undefined, entry,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  async () => ({}), async () => { throw Error('No real login in client boot fixture') })
let browser, page
const errors = []
const report = { scope: 'Actual official frontend and module Loader against isolated Host; no production account or inference', version: manifest.version }
try {
  const ready = await host.start()
  const origin = new URL(ready.url).origin
  const cookie = await authenticateWebHost(ready.url)
  const separator = cookie.indexOf('=')
  const webRoot = dirname(require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'))
  const document = await (await serveWebDocument(new Request('dsh-app://app/'), webRoot)).text()
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_NEXT_TEST_BROWSER_CHANNEL ? { channel: process.env.DSH_NEXT_TEST_BROWSER_CHANNEL } : {}) })
  const context = await browser.newContext({ viewport: { width: 1100, height: 780 }, locale: 'zh-CN' })
  await context.grantPermissions(['local-network-access'], { origin })
  await context.addCookies([{ url: origin, name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }])
  await context.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: document }))
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.origin === origin ? route.fallback() : route.abort()
  })
  await context.exposeFunction('__desktopBoot', async () => ({ injections: await host.collectInjections(), streamBaseUrl: origin }))
  await context.exposeFunction('__desktopState', () => ({ selected: 'desktop', profiles: ['desktop'], unavailableProfiles: [], features: { market: true, remoteControl: false }, preferences: DEFAULT_PREFERENCES, phase: 'ready', busy: false, failure: '', safeMode: false, onboarding: false, home, platform: 'win32', version: manifest.version, logs: '', notificationsAvailable: false }))
  await context.addInitScript(() => {
    globalThis.dshDesktop = { protocolVersion: 1 }
    globalThis.dshDesktopBoot = { ready: () => globalThis.__desktopBoot(), failed: message => { globalThis.__desktopFailure = message } }
    globalThis.dshDesktopSetup = { read: async () => ({ required: false, accountPending: false }) }
    globalThis.desktopNext = {
      state: () => globalThis.__desktopState(), command: async () => {},
      renderer: { profile: () => 'desktop', report: async status => { globalThis.__desktopHealth = status } },
    }
  })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  await page.waitForFunction(() => globalThis.__desktopHealth === 'healthy' || globalThis.__desktopFailure, undefined, { timeout: 20_000 })
  const boot = await page.evaluate(() => ({ health: globalThis.__desktopHealth, failure: globalThis.__desktopFailure, skillStyles: !!document.getElementById('dsh-desktop-skill-settings') }))
  assert.equal(boot.failure, undefined, String(boot.failure))
  assert.equal(boot.health, 'healthy')
  assert.equal(boot.skillStyles, true, 'Desktop Skill client must activate in the real module Loader')
  assert.deepEqual(errors, [])
  Object.assign(report, { passed: true, ...boot })
  await page.screenshot({ path: join(output, 'client-boot.png') })
  console.log(JSON.stringify(report))
} catch (error) {
  Object.assign(report, { passed: false, error: String(error), errors })
  await page?.screenshot({ path: join(output, 'client-boot-failed.png') }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  await host.stop(true)
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
  rmSync(home, { recursive: true, force: true })
}

