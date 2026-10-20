/** Start the isolated internal Windows NSIS packaging flow without mutating the caller environment. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./package-win.ts', import.meta.url))
const result = spawnSync(process.execPath, [entry], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env, DSH_COMPANY_TEST_WINDOWS: '1' },
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) process.exitCode = result.status ?? 1
