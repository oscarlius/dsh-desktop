import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/product-identity.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/product-identity.ts')>(),
  DESKTOP_COMPANY_SERVICE_ENABLED: true,
}))

const { prepareDesktopProfile } = await import('../src/profile.ts')
const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function rowsFor(patch: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'company-fetch-profile-'))
  homes.push(home)
  const profile = prepareDesktopProfile(undefined, home, 'win32')
  writeFileSync(profile.profile.patchPath, JSON.stringify(patch))
  return composeEntries([prepareDesktopProfile(undefined, home, 'win32').patches])
}

it('keeps explicit DeepSeek API provider and row choices in Company composition', () => {
  let rows = rowsFor([{ id: 'web', config: { searchProvider: 'deepseek-search-api', fetchProvider: 'http' } }])
  expect(rows.find(row => row.id === 'web-deepseek-api')?.disabled).not.toBe(true)

  rows = rowsFor([
    { id: 'web-deepseek-api', disabled: true },
    { id: 'web-deepseek-api', disabled: false },
  ])
  expect(rows.find(row => row.id === 'web-deepseek-api')).toMatchObject({ disabled: false })

  rows = rowsFor([
    { id: 'web-deepseek-api', disabled: false },
    { id: 'web-deepseek-api', disabled: true },
  ])
  expect(rows.find(row => row.id === 'web-deepseek-api')).toMatchObject({ disabled: true })
})
