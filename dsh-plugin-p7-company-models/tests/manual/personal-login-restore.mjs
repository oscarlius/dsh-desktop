/** Real local HTTPS identity routes; upstream Feishu identity is an explicit fixture. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AccountBroker } from '../../lib/account-broker.js'

const [metadataPath, reportPath] = process.argv.slice(2)
const info = JSON.parse(await readFile(metadataPath, 'utf8'))
assert.equal(new URL(info.origin).hostname, '127.0.0.1')
assert.equal(process.env.NODE_EXTRA_CA_CERTS, info.ca)
assert(process.env.P7_LOCAL_ADMIN_TOKEN)
const requireDesktop = createRequire(pathToFileURL(resolve('dsh-plugin-desktop-beta/package.json')))
const ts = requireDesktop('typescript')
const temporary = await mkdtemp(join(tmpdir(), 'p7-personal-restore-'))
const key = randomBytes(32)
const report = { passed: false, transport: 'real local HTTPS', oauth: 'local Feishu fixture', vault: 'product vault with AES fixture protector; real Windows OS protector tested separately', checks: [] }
let first, restored, blocked, newcomer
let original
const admin = async (path, body) => {
  const response = await fetch(info.origin + path, { method: body ? 'PUT' : 'GET', headers: { authorization: 'Bearer ' + process.env.P7_LOCAL_ADMIN_TOKEN, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error' })
  assert.equal(response.status, 200, await response.clone().text())
  return await response.json()
}
const configure = async values => admin('/api/v1/admin/identity/organization', { name: original.name, gatewayAccessKeyId: original.gatewayAccessKeyId, reason: 'local acceptance only', ...values })
const check = value => { report.checks.push(value); console.log('PASS ' + value) }
try {
  const source = (await readFile(resolve('dsh-plugin-desktop-beta/src/p7-session-vault.ts'), 'utf8'))
    .replace("'@deepseek-ai/dsh-atomic-write'", JSON.stringify(pathToFileURL(requireDesktop.resolve('@deepseek-ai/dsh-atomic-write')).href))
  await writeFile(join(temporary, 'vault.mjs'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
  const { createP7SessionVault } = await import(pathToFileURL(join(temporary, 'vault.mjs')).href)
  const protector = { available: true,
    seal(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    open(value) { const raw = Buffer.from(value), decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]) },
  }
  const vault = createP7SessionVault(temporary, protector)
  const store = { load: async origin => (await vault({ action: 'load', origin })).refreshToken, save: async (origin, refreshToken) => { await vault({ action: 'save', origin, refreshToken }) }, clear: async origin => { await vault({ action: 'clear', origin }) } }
  const options = { origin: () => info.origin, profileId: temporary, clientVersion: '2.0.18-beta.15', store }
  original = (await admin('/api/v1/admin/identity/organization')).organization
  await configure({ minimumDesktopVersion: null, upgradeMessage: null, upgradeUrl: null })
  const authorize = employee => async url => {
    const landing = await fetch(url, { redirect: 'error' })
    assert.equal(landing.status, 200)
    assert.equal(landing.headers.get('referrer-policy'), 'no-referrer')
    const html = await landing.text()
    assert(html.includes('使用飞书继续'))
    const href = html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&')
    const continuation = await fetch(new URL(href, info.origin), { redirect: 'manual' })
    assert.equal(continuation.status, 302)
    assert.equal(new URL(continuation.headers.get('location')).pathname, '/_fixture/authorize')
    const provider = new URL(continuation.headers.get('location')); provider.searchParams.set('employee', employee)
    const complete = await fetch(provider)
    assert.equal(complete.status, 200)
    await complete.text()
  }
  first = new AccountBroker({ ...options, openBrowser: authorize('a') })
  await first.login()
  const until = Date.now() + 10000
  while (first.status().phase === 'pending' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(first.status().phase, 'signed-in')
  assert((await store.load(info.origin)).startsWith('p7r_'))
  const firstAccess = await first.getValidAccessToken()
  check('custom company page -> Feishu fixture -> PKCE callback -> encrypted refresh save')
  await first.dispose()
  restored = new AccountBroker({ ...options, openBrowser: () => assert.fail('restore opened a browser') })
  restored.setPersonalMode(true)
  await Promise.all([restored.restore(), restored.restore()])
  assert.equal(restored.status().phase, 'signed-in')
  assert.notEqual(await restored.getValidAccessToken(), firstAccess)
  assert.equal((await restored.usage('2026-10-20T00:00:00Z', '2026-10-23T00:00:00Z')).totals.requests, 0)
  check('new broker restores and rotates refresh credential without browser login')
  newcomer = new AccountBroker({ ...options, profileId: temporary + '-new-employee', store: undefined, openBrowser: authorize('c') })
  await newcomer.login()
  const activationDeadline = Date.now() + 10000
  while (newcomer.status().phase === 'pending' && Date.now() < activationDeadline) await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(newcomer.status().phase, 'signed-in')
  assert.equal(newcomer.status().profile.role, 'employee')
  assert.equal(newcomer.status().profile.organizationId, 'org')
  check('first company employee login autoactivates user, membership and device without admin approval')
  const refresh = await store.load(info.origin)
  await configure({ minimumDesktopVersion: '2.0.18-beta.16', upgradeMessage: '请更新测试客户端后登录', upgradeUrl: 'https://downloads.example/dsh' })
  const response = await fetch(info.origin + '/api/v1/desktop-auth/token/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }) })
  assert.equal(response.status, 426)
  assert.equal(typeof (await response.json()).detail, 'string')
  assert.equal(response.headers.get('x-p7-minimum-desktop-version'), '2.0.18-beta.16')
  assert.equal(response.headers.get('x-p7-upgrade-url'), 'https://downloads.example/dsh')
  blocked = new AccountBroker({ ...options, openBrowser: () => assert.fail('outdated client opened browser') })
  blocked.setPersonalMode(true)
  await blocked.restore()
  assert.equal(blocked.status().phase, 'upgrade-required')
  assert.equal(blocked.status().upgradeUrl, 'https://downloads.example/dsh')
  const expired = await fetch(info.origin + '/api/v1/me', { headers: { authorization: 'Bearer ' + await restored.getValidAccessToken() } })
  assert.equal(expired.status, 426)
  const legacy = await fetch(info.origin + '/v1/desktop/model-config', { headers: { authorization: 'Bearer p7k_LOCAL_ACCEPTANCE_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' } })
  assert.equal(legacy.status, 200)
  check('server blocks old personal login/refresh/current session; legacy shared-key catalog remains compatible')
  await blocked.logout()
  assert.equal(await store.load(info.origin), undefined)
  check('logout while upgrade-blocked clears saved refresh credential')
  report.passed = true
} catch (error) { report.error = String(error); throw error }
finally {
  if (original) await configure({ minimumDesktopVersion: original.minimumDesktopVersion, upgradeMessage: original.upgradeMessage, upgradeUrl: original.upgradeUrl })
  await restored?.logout(); await newcomer?.logout(); await first?.dispose(); await restored?.dispose(); await blocked?.dispose(); await newcomer?.dispose()
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  key.fill(0)
  await rm(temporary, { recursive: true, force: true })
}
