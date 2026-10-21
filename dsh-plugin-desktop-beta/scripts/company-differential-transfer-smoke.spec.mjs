import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./company-differential-transfer-smoke.mjs', import.meta.url)), 'utf8')

for (const required of [
  "const PUBLIC_ORIGIN = 'https://maas.zxrc.com.cn:8090'",
  "'normal', 'missing-blockmap', 'range-failure', 'corrupt-cache'",
  'class LocalCompanyHttpExecutor extends HttpExecutor',
  'new NsisUpdater(',
  'GenericDifferentialDownloader',
  'updater.httpExecutor = executor',
  "updaterCacheDirName: CACHE_NAME",
  "join(stableCache, 'installer.exe')",
  "join(stableCache, 'current.blockmap')",
  "responseStatus === 206",
  "responseStatus === 200",
  'function reusedBlockOffset',
  'No reusable block was found',
  'fallbackForced: fallbackLog',
  'entries: requests.map',
  'Downloaded installer SHA256 differs from CandidateInstaller',
  'installerExecuted: false',
]) assert.ok(source.includes(required), `missing real-transfer guard: ${required}`)

for (const forbidden of ['disableDifferentialDownload = true', 'mock differential', 'spawn(', 'exec(']) {
  assert.ok(!source.includes(forbidden), `transfer harness must not use ${forbidden}`)
}

console.log('company differential transfer smoke static contract: passed')
