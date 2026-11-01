import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadNextProfile, NEXT_PACKAGE, NextProfiles, readNextProfilePatches } from '../src/profiles.ts'
import { COMPANY_DEFAULT_PLUGIN_BUNDLES, companyMnemonCliPath } from '../src/company-plugin-defaults.ts'

it('patches the existing Web module without creating a nameless duplicate', () => {
  const home = mkdtempSync(join(tmpdir(), 'company-composition-'))
  try {
    const manager = new NextProfiles(home)
    const directory = manager.ensure('desktop')
    expect(manager.features('desktop')).toEqual({ remoteControl: false, market: true })
    manager.setFeatures('desktop', { remoteControl: false, market: false })
    manager.ensure('desktop')
    expect(manager.features('desktop')).toEqual({ remoteControl: false, market: false })
    const initialProfile = loadNextProfile(directory, home)
    const overlayPath = join(directory, 'desktop-next.cordis.patch.json')
    const initial = applyEntryPatches([], [...initialProfile.layers.flatMap(layer => layer.patches), ...initialProfile.patches,
      ...JSON.parse(readFileSync(overlayPath, 'utf8'))], () => {})
    for (const id of ['ui-settings-account', 'message-feedback', 'ui-message-feedback']) {
      expect(initial.find(row => row.id === id)).toMatchObject({ disabled: true })
    }
    expect(initial.find(row => row.id === 'p7-company-models')?.disabled).not.toBe(true)
    const overlays = [overlayPath]
    const rows = applyEntryPatches([], readNextProfilePatches(directory, home, overlays), () => {})
    expect(rows.filter(row => row.id === 'web')).toHaveLength(1)
    expect(rows.find(row => row.id === 'web')).toMatchObject({ name: '@deepseek-ai/dsh-web', config: { searchProvider: 'p7', fetchProvider: 'http' } })
    expect(rows.find(row => row.id === 'web-deepseek-api')).toMatchObject({ disabled: true })
    expect(rows.every(row => typeof row.name === 'string')).toBe(true)
    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'web', config: { searchProvider: 'explicit-user-provider', fetchProvider: 'deepseek-fetch-api' } },
      { id: 'p7-company-models', config: { requirePersonalLogin: false } },
    ]))
    const reloaded = applyEntryPatches([], readNextProfilePatches(directory, home, overlays), () => {})
    expect(reloaded.find(row => row.id === 'web')).toMatchObject({ name: '@deepseek-ai/dsh-web', config: { searchProvider: 'explicit-user-provider', fetchProvider: 'deepseek-fetch-api' } })
    expect(reloaded.find(row => row.id === 'web-deepseek-api')?.disabled).not.toBe(true)
    expect(reloaded.find(row => row.id === 'p7-company-models')).toMatchObject({ config: { requirePersonalLogin: true } })
    for (const id of ['ui-settings-account', 'message-feedback', 'ui-message-feedback']) {
      expect(reloaded.find(row => row.id === id)).toMatchObject({ disabled: true })
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('preserves an operational fetch-provider override instead of applying the Company default', () => {
  const home = mkdtempSync(join(tmpdir(), 'company-fetch-provider-'))
  try {
    vi.stubEnv('DSH_WEB_FETCH_PROVIDER', 'deepseek-fetch-api')
    const manager = new NextProfiles(home)
    const directory = manager.ensure('desktop')
    const rows = applyEntryPatches([], readNextProfilePatches(directory, home, []), () => {})
    expect(rows.find(row => row.id === 'web-deepseek-api')?.disabled).not.toBe(true)
  } finally {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
})

it('adds the safe fetch default when an existing Company Profile is reloaded', () => {
  const home = mkdtempSync(join(tmpdir(), 'company-fetch-reload-'))
  try {
    const manager = new NextProfiles(home)
    const directory = manager.ensure('desktop')
    // Pre-existing Company profiles pinned only the P7 search provider.
    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'web', config: { searchProvider: 'p7' } },
    ]))
    for (const rows of [
      applyEntryPatches([], readNextProfilePatches(directory, home, []), () => {}),
      applyEntryPatches([], readNextProfilePatches(directory, home, []), () => {}),
    ]) {
      expect(rows.find(row => row.id === 'web')).toMatchObject({ config: { searchProvider: 'p7', fetchProvider: 'http' } })
      expect(rows.find(row => row.id === 'web-deepseek-api')).toMatchObject({ disabled: true })
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('retains explicit DeepSeek API provider and row enablement choices', () => {
  const home = mkdtempSync(join(tmpdir(), 'company-deepseek-fetch-choice-'))
  try {
    const manager = new NextProfiles(home)
    const directory = manager.ensure('desktop')
    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'web', config: { searchProvider: 'deepseek-search-api', fetchProvider: 'http' } },
    ]))
    let rows = applyEntryPatches([], readNextProfilePatches(directory, home, []), () => {})
    expect(rows.find(row => row.id === 'web-deepseek-api')?.disabled).not.toBe(true)

    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'web-deepseek-api', disabled: true },
      { id: 'web-deepseek-api', disabled: false },
    ]))
    rows = applyEntryPatches([], readNextProfilePatches(directory, home, []), () => {})
    expect(rows.find(row => row.id === 'web-deepseek-api')).toMatchObject({ disabled: false })

    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'web-deepseek-api', disabled: false },
      { id: 'web-deepseek-api', disabled: true },
    ]))
    rows = applyEntryPatches([], readNextProfilePatches(directory, home, []), () => {})
    expect(rows.find(row => row.id === 'web-deepseek-api')).toMatchObject({ disabled: true })
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('selects complete Company plugin bundles once while preserving Profile opt-outs and live settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'company-plugin-defaults-'))
  try {
    const manager = new NextProfiles(home)
    const directory = manager.ensure('desktop')
    const manifestPath = join(directory, 'package.json')
    let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const bundle of COMPANY_DEFAULT_PLUGIN_BUNDLES) expect(manifest.dsh.profile.bundles).toContain(bundle)
    expect(manifest.dsh.desktopNextCompanyPluginDefaults).toBe(1)

    const profile = loadNextProfile(directory, home)
    for (const bundle of COMPANY_DEFAULT_PLUGIN_BUNDLES) {
      expect(profile.layers.filter(layer => layer.packageName === bundle)).toHaveLength(1)
    }
    let patches = readNextProfilePatches(directory, home, [])
    let rows = applyEntryPatches([], patches, () => {})
    expect(rows.filter(row => row.id === 'better-sidebar')).toHaveLength(1)
    expect(rows.find(row => row.id === 'better-sidebar')).toMatchObject({ config: { autoOpenSubagent: false, autoOpenJobs: false } })
    // Mnemon's published bundle intentionally nests its components beneath a
    // group. The loader expands that group; our top-level overrides must stay
    // separate rather than duplicate its Sources/Strategies insertion.
    expect(patches.find(row => row.id === 'mnemon')).toMatchObject({ config: {
      idleReview: { enabled: false }, embedding: { enabled: false }, storageScope: 'workspaces', dataDir: join(home, 'mnemon'),
      cliPath: companyMnemonCliPath(NEXT_PACKAGE),
      skills: { evolution: false, autoBacktest: false },
    } })
    expect(patches.find(row => row.id === 'mnemon-source-skills')).toMatchObject({ disabled: true })

    // Volatile Settings writes live in the Profile patch and take precedence
    // over Company first-run defaults on every reload.
    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'better-sidebar', config: { autoOpenSubagent: true, autoOpenJobs: true } },
      { id: 'mnemon', config: { idleReview: { enabled: true }, skills: { evolution: true, autoBacktest: true } } },
    ]))
    patches = readNextProfilePatches(directory, home, [])
    rows = applyEntryPatches([], patches, () => {})
    expect(rows.find(row => row.id === 'better-sidebar')).toMatchObject({ config: { autoOpenSubagent: true, autoOpenJobs: true } })
    expect(patches.filter(row => row.id === 'mnemon').at(-1)).toMatchObject({ config: {
      idleReview: { enabled: true }, skills: { evolution: true, autoBacktest: true },
    } })

    // Once migrated, an intentional bundle removal remains an opt-out.
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((bundle: string) => bundle !== 'dsh-mnemon')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    manager.ensure('desktop')
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).dsh.profile.bundles).not.toContain('dsh-mnemon')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('resolves Mnemon from the app-owned platform package instead of a global command', () => {
  const path = companyMnemonCliPath(NEXT_PACKAGE)
  expect(path?.replaceAll('\\', '/')).toMatch(new RegExp(`@mnemon-dev/mnemon-${process.platform}-${process.arch}/bin/mnemon${process.platform === 'win32' ? '\\.exe' : ''}$`, 'u'))
})

it('honors a legacy explicit Company plugin disable before its one-time migration', () => {
  const home = mkdtempSync(join(tmpdir(), 'company-plugin-opt-out-'))
  try {
    const manager = new NextProfiles(home)
    const directory = manager.create('desktop')
    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'better-sidebar', disabled: true },
      { id: 'mnemon', disabled: true },
    ]))
    // Simulate a Profile created before the Company defaults migration.
    const manifestPath = join(directory, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((bundle: string) => !new Set<string>(COMPANY_DEFAULT_PLUGIN_BUNDLES).has(bundle))
    delete manifest.dsh.desktopNextCompanyPluginDefaults
    writeFileSync(manifestPath, JSON.stringify(manifest))
    manager.ensure('desktop')
    const migrated = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(migrated.dsh.profile.bundles).not.toEqual(expect.arrayContaining([...COMPANY_DEFAULT_PLUGIN_BUNDLES]))
    expect(migrated.dsh.desktopNextCompanyPluginDefaults).toBe(1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})
