import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadNextProfile, NextProfiles, readNextProfilePatches } from '../src/profiles.ts'

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
