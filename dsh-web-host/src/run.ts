import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { prepareProfile } from '@deepseek-ai/dsh/profile-boot'
import { ensureWritableHome, launchOfficialWeb } from './launcher.js'
import { linkManagedPackages, renderWebPatch } from './profile.js'
import { forwardShutdownSignals } from './shutdown.js'

function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
function containerIpv4(): string {
  const preferred = networkInterfaces().eth0?.find(item => item.family === 'IPv4' && !item.internal)?.address
  const fallback = Object.values(networkInterfaces()).flat().find((item): item is NonNullable<typeof item> => item?.family === 'IPv4' && !item.internal)?.address
  const selected = preferred ?? fallback
  if (!selected) throw new Error('No non-loopback IPv4 address is available for the official Web listener.')
  return selected
}
/** Startup milestones go to stderr; the token URL never leaves the capture path. */
function milestone(step: string): void { console.error(`dsh-web-host: ${step}`) }

async function main(): Promise<void> {
  const publicUrl = required('DSH_WEB_PUBLIC_URL')
  const authority = new URL(publicUrl).host
  if (new URL(publicUrl).protocol !== 'https:') throw new Error('DSH_WEB_PUBLIC_URL must be HTTPS.')
  const publicOrigin = new URL(publicUrl).origin
  const companyOrigin = process.env.P7_WEB_COMPANY_ORIGIN ?? (process.env.NODE_ENV === 'production' ? required('P7_WEB_COMPANY_ORIGIN') : publicOrigin)
  const home = required('DSH_HOME')
  milestone(`writable home ready at ${ensureWritableHome(home)}`)
  const patch = process.env.DSH_WEB_PATCH ?? '/opt/dsh/web-profile.patch.yml'
  const port = process.env.DSH_WEB_PORT ?? '3080'
  const require = createRequire(import.meta.url)
  const profile = prepareProfile('web')
  milestone(`web profile prepared under ${profile.dir}`)
  await linkManagedPackages(profile.dir, {
    'dsh-web-host': fileURLToPath(new URL('../', import.meta.url)),
    'dsh-plugin-p7-company-models': dirname(require.resolve('dsh-plugin-p7-company-models/package.json')),
    'dsh-plugin-p7-mcp': dirname(require.resolve('dsh-plugin-p7-mcp/package.json')),
    'dsh-plugin-p7-web-search': fileURLToPath(new URL('../../dsh-plugin-p7-web-search/', import.meta.url)),
    'dsh-streamfold': dirname(require.resolve('dsh-streamfold/package.json')),
    'dsh-better-sidebar': dirname(require.resolve('dsh-better-sidebar/package.json')),
    'dsh-claude-artifacts': dirname(require.resolve('dsh-claude-artifacts/package.json')),
    'dsh-claude-data': dirname(require.resolve('dsh-claude-data/package.json')),
  })
  milestone('managed packages linked')
  const renderedPatch = '/run/p7-web-state/web-profile.patch.yml'
  await renderWebPatch(resolve(patch), renderedPatch, publicOrigin, companyOrigin)
  milestone(`web patch rendered for ${authority}`)
  const command = process.env.DSH_WEB_DSH_BIN ?? process.execPath
  const cliArgs = process.env.DSH_WEB_DSH_BIN ? [] : [join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')]
  const host = containerIpv4()
  milestone(`launching official web on ${host}:${port}`)
  const child = await launchOfficialWeb({ command, upstreamOrigin: `http://${host}:${port}`, publicAuthority: authority,
    args: [...cliArgs, 'web', '--patch', renderedPatch, '--no-open', '--host', host, '--port', port, '--public-url', publicUrl, '--trusted-host', authority], })
  milestone('official core cookie stored; startup complete')
  forwardShutdownSignals(process, child)
}

main().catch((error: unknown) => {
  console.error(`dsh-web-host: startup failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
