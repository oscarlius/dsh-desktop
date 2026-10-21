/** The production entry point: build both distributions, then publish their verified manifest. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
try {
  const args = process.argv.slice(2)
  if (args.includes('--bundle') || args.includes('--dry-run')) throw new Error('Use publish:company-release for an existing bundle or local dry run')
  for (const flag of ['--notes-file', '--reason']) {
    const value = args[args.indexOf(flag) + 1]
    if (!args.includes(flag) || !value || value.startsWith('--')) throw new Error(`release:company requires ${flag}`)
  }
  if (!existsSync(resolve(args[args.indexOf('--notes-file') + 1]))) throw new Error('Release notes file is missing')
  if (![process.env.P7_ADMIN_TOKEN_FILE, process.env.P7_BOOTSTRAP_PASSWORD_FILE].some(path => path && existsSync(path))) {
    throw new Error('Set P7_ADMIN_TOKEN_FILE or P7_BOOTSTRAP_PASSWORD_FILE to a protected administrator credential file')
  }
  const version = JSON.parse(readFileSync(join(root, 'dsh-plugin-desktop-beta/package.json'), 'utf8')).version
  const directory = resolve(process.env.DSH_COMPANY_RELEASE_OUTPUT ?? join(root, 'dsh-plugin-desktop-beta/dist-company', version))
  if (existsSync(directory)) throw new Error('Release bundle already exists; use publish:company-release to resume its upload')
  const shell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/cmd.exe') : 'sh'
  const command = process.platform === 'win32' ? ['/d', '/s', '/c', 'corepack yarn dist:win-company-release'] : ['-c', 'corepack yarn dist:win-company-release']
  const build = spawnSync(shell, command, { cwd: root, env: process.env, stdio: 'inherit' })
  if (build.error) throw build.error
  if (build.status !== 0) throw new Error('Paired package build failed; no P7 publication was attempted')
  const publish = spawnSync(process.execPath, [join(root, 'scripts/publish-company-release.mjs'), '--bundle', directory, ...args], { cwd: root, env: process.env, stdio: 'inherit' })
  if (publish.error) throw publish.error
  process.exitCode = publish.status ?? 1
} catch (error) { console.error(error instanceof Error ? error.message : 'Company release failed'); process.exitCode = 1 }
