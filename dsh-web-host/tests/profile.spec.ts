import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { linkManagedPackages, renderWebPatch } from '../src/profile.js'

const roots: string[] = []
async function fixture(): Promise<string> { const root = await mkdtemp(join(tmpdir(),'dsh-web-profile-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })

it('renders distinct workspace and company origins outside the persistent profile', async () => {
  const root = await fixture(), source = join(root,'image.patch.yml'), output = join(root,'private','rendered.yml')
  await writeFile(source,'trusted: https://replace-at-build.invalid\ncompany: https://replace-company-at-build.invalid\n')
  await renderWebPatch(source,output,'https://workspace.example:8092','https://account.example:8090')
  expect(await readFile(output,'utf8')).toBe('trusted: "https://workspace.example:8092"\ncompany: "https://account.example:8090"\n')
  expect(await readFile(source,'utf8')).toContain('replace-at-build.invalid')
  await expect(renderWebPatch(source,output,'http://p7.example','https://account.example')).rejects.toThrow('HTTPS')
})

it('maps the committed production overlay to the workspace and company origins', async () => {
  const root = await fixture(), output = join(root, 'private', 'rendered.yml')
  const template = fileURLToPath(new URL('../web-profile.patch.yml', import.meta.url))
  await renderWebPatch(template, output, 'https://workspace.example:8092', 'https://account.example:8090')
  const rendered = await readFile(output, 'utf8')
  expect(rendered).toContain('inject: [p7WebTrustedSession, webServer, agents, connection, workspaceRegistry]')
  expect(rendered).toContain('publicOrigin: "https://workspace.example:8092"')
  expect(rendered).toContain('companyOrigin: "https://account.example:8090"')
  expect(rendered).toContain('name: dsh-claude-artifacts')
  expect(rendered).toContain('name: dsh-claude-data')
})

it('links only image-owned packages and refuses to replace an existing personal package', async () => {
  const root = await fixture(), source = join(root,'image-package'), profile = join(root,'personal')
  await mkdir(source); await linkManagedPackages(profile,{'dsh-web-host':source})
  await linkManagedPackages(profile,{'dsh-web-host':source})
  expect(await realpath(join(profile,'node_modules','dsh-web-host'))).toBe(await realpath(source))
  const owned = join(profile,'node_modules','personal-plugin'); await mkdir(owned); await writeFile(join(owned,'data'),'retain')
  await expect(linkManagedPackages(profile,{'personal-plugin':source})).rejects.toThrow('occupied')
  expect(await readFile(join(owned,'data'),'utf8')).toBe('retain')
})

it('injects the company route admission into the company-models web plugin', () => {
  const patch = readFileSync(new URL('../web-profile.patch.yml', import.meta.url), 'utf8')
  const block = patch.split('- id: p7-company-models')[1]?.split('- id:')[0] ?? ''
  const inject = /inject:\s*\[([^\]]+)\]/.exec(block)?.[1].split(',').map(item => item.trim()) ?? []
  for (const service of ['loader', 'webServer', 'settings', 'credentials', 'profileContext', 'llm', 'agentDefaultModel', 'p7CompanyRouteAdmission']) {
    expect(inject).toContain(service)
  }
})
