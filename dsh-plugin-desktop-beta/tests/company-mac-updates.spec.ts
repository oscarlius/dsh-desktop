import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { checkCompanyRelease, COMPANY_MAC_RELEASE_ENDPOINT, companyInstallerUrl } from '../src/company-update-check.ts'
import { createCompanyUpdateAdapter } from '../src/company-updates.ts'
import { NextUpdates } from '../src/updates.ts'

const roots: string[] = []
const owners: NextUpdates[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const bytes = Buffer.alloc(1024); bytes.write('koly', 512)
const version = '2.0.29-beta.15'
const metadata = () => ({ published: true, channel: 'companytest', platform: 'darwin', architecture: 'universal',
  version, releaseNotes: 'Mac full update', size: bytes.length,
  downloadUrl: `https://maas.zxrc.com.cn:8090/ui/downloads/dsh/companytest-mac/${version}/P7-DSH-Company-Test-${version}-universal.dmg`,
  sha256: createHash('sha256').update(bytes).digest('hex') })

it('checks the separate Mac feed and rejects a Windows response', async () => {
  const request = vi.fn(async (_url: string) => Response.json(metadata()))
  await expect(checkCompanyRelease('2.0.28-beta.15', request, undefined, 'darwin')).resolves.toMatchObject({ status: 'update-available', platform: 'darwin', architecture: 'universal' })
  expect(request.mock.calls[0]?.[0]).toBe(COMPANY_MAC_RELEASE_ENDPOINT)
  await expect(checkCompanyRelease(version, async () => Response.json({ ...metadata(), platform: 'win32' }), undefined, 'darwin')).rejects.toThrow('Mac release')
  expect(() => companyInstallerUrl(metadata().downloadUrl, version)).toThrow('address')
  await expect(checkCompanyRelease(version, async () => Response.json({ published: false, channel: 'companytest', platform: 'darwin' }), undefined, 'darwin')).resolves.toEqual({ status: 'not-published' })
})

it('downloads only the pinned DMG, waits for install and preserves profile/auth/chat files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'company-mac-update-')); roots.push(root)
  const profile = join(root, 'profile.json'); await writeFile(profile, '{"chat":"keep","auth":"fixture"}')
  const request = vi.fn(async (_url: string) => Response.json(metadata()))
  const artifactRequest = vi.fn(async (url: string) => ({ response: new Response(bytes), finalUrl: url }))
  const company = createCompanyUpdateAdapter({ platform: 'darwin', request, artifactRequest, log: vi.fn() })
  const prepare = vi.fn(async (path: string) => { expect(await readFile(path)).toEqual(bytes) })
  const install = vi.fn(async () => {})
  const updates = new NextUpdates({ platform: 'darwin', version: '2.0.28-beta.15', packaged: true, userData: root,
    request: async () => { throw new Error('upstream must not be used') }, artifactRequest, company, prepare, install, changed() {}, log: vi.fn() })
  owners.push(updates)
  await updates.check(); expect(updates.snapshot()).toMatchObject({ phase: 'available', installable: true })
  await updates.download(); expect(updates.snapshot().phase).toBe('ready')
  expect(prepare).toHaveBeenCalledOnce(); expect(install).not.toHaveBeenCalled()
  expect(artifactRequest).toHaveBeenCalledOnce()
  expect(artifactRequest.mock.calls[0]?.[0]).toBe(metadata().downloadUrl)
  await updates.install(); expect(install).toHaveBeenCalledOnce()
  expect(await readFile(profile, 'utf8')).toBe('{"chat":"keep","auth":"fixture"}')
})

it('does not prepare or install a corrupted Mac download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'company-mac-bad-update-')); roots.push(root)
  const request = vi.fn(async () => Response.json({ ...metadata(), sha256: '0'.repeat(64) }))
  const artifactRequest = vi.fn(async (url: string) => ({ response: new Response(bytes), finalUrl: url }))
  const prepare = vi.fn(); const install = vi.fn()
  const updates = new NextUpdates({ platform: 'darwin', version: '2.0.28-beta.15', packaged: true, userData: root,
    request, artifactRequest, company: createCompanyUpdateAdapter({ platform: 'darwin', request, artifactRequest, log() {} }),
    prepare, install, changed() {}, log() {} })
  owners.push(updates)
  await updates.download(); await updates.install()
  expect(updates.snapshot()).toMatchObject({ phase: 'error', error: 'download' })
  expect(prepare).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled()
})
