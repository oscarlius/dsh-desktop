/** Verify the internal test installer identity, unsigned state, hashes, and packaged runtime metadata. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
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
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', path], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) throw result.error ?? new Error(result.stderr || 'Get-AuthenticodeSignature failed')
  return JSON.parse(result.stdout)
}

for (const [path, label] of [[installer, 'Company test NSIS installer'], [application, 'Company test application']]) {
  assertPortableExecutable(path, label)
  const state = signature(path)
  if (state.status !== 'NotSigned') throw new Error(`${label} must be unsigned; received Authenticode status ${state.status}`)
  console.log(`${label}: sha256=${createHash('sha256').update(readFileSync(path)).digest('hex')} signature=${state.status}`)
}
const packaged = JSON.parse(readFileSync(manifest, 'utf8'))
if (packaged.dshDesktopFlavor !== 'companytest') throw new Error('packaged runtime does not carry the companytest flavor marker')
console.log(`Company test packaged runtime verified: ${manifest}`)
