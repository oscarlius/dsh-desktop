/** Two real Electron processes exercise the OS-backed vault with synthetic credentials. */
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const electron = require('electron')
const directory = await mkdtemp(join(tmpdir(), 'p7-native-vault-'))
const reportPath = process.argv[2]
try {
  const source = (await readFile(new URL('../../src/p7-session-vault.ts', import.meta.url), 'utf8'))
    .replace("'@deepseek-ai/dsh-atomic-write'", JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href))
  await writeFile(join(directory, 'vault.mjs'), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText)
  await writeFile(join(directory, 'main.cjs'), `
const { app, safeStorage } = require('electron')
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')
const { mkdir, readdir, readFile } = require('node:fs/promises')
app.setPath('userData', join(__dirname, 'electron-user'))
app.whenReady().then(async () => {
  const { createP7SessionVault } = await import(pathToFileURL(join(__dirname, 'vault.mjs')).href)
  const profile = join(__dirname, 'profile')
  await mkdir(profile, { recursive: true })
  const vault = createP7SessionVault(profile, {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())),
    seal: value => safeStorage.encryptString(Buffer.from(value).toString('utf8')),
    open: value => Buffer.from(safeStorage.decryptString(Buffer.from(value)), 'utf8'),
  })
  const origin = 'https://p7.example'
  const refreshToken = 'p7r_synthetic-native-vault-acceptance'
  if (process.argv[2] === 'save') {
    await vault({ action: 'save', origin, refreshToken })
    const file = (await readdir(profile)).find(name => name.endsWith('.bin'))
    if (!file || (await readFile(join(profile, file))).includes(Buffer.from(refreshToken))) throw new Error('plaintext credential detected')
  } else {
    if ((await vault({ action: 'load', origin })).refreshToken !== refreshToken) throw new Error('cross-process restore failed')
    await vault({ action: 'clear', origin })
    if ((await vault({ action: 'load', origin })).refreshToken !== undefined) throw new Error('logout clear failed')
  }
  app.exit(0)
}).catch(error => { console.error(error.message); app.exit(1) })
`)
  for (const phase of ['save', 'restore']) {
    await new Promise((resolve, reject) => {
      const environment = { ...process.env }
      delete environment.ELECTRON_RUN_AS_NODE
      const child = spawn(electron, [join(directory, 'main.cjs'), phase], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Electron vault ${phase} timed out`)) }, 30_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Electron vault ${phase} failed (${code}): ${output.slice(-1500)}`)) })
    })
  }
  const report = { passed: true, platform: process.platform, electron: require('electron/package.json').version, checks: ['OS-encrypted ciphertext only', 'new-process restore', 'explicit logout clears ciphertext'], credential: 'synthetic fixture only' }
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log('P7 native encrypted vault: save, process restart, restore and clear passed')
} finally { await rm(directory, { recursive: true, force: true }) }
