import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
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
    expect(rows.find(row => row.id === 'web')).toMatchObject({ name: '@deepseek-ai/dsh-web', config: { searchProvider: 'p7' } })
    expect(rows.every(row => typeof row.name === 'string')).toBe(true)
    writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
      { id: 'web', config: { searchProvider: 'explicit-user-provider' } },
      { id: 'p7-company-models', config: { requirePersonalLogin: false } },
    ]))
    const reloaded = applyEntryPatches([], readNextProfilePatches(directory, home, overlays), () => {})
    expect(reloaded.find(row => row.id === 'web')).toMatchObject({ name: '@deepseek-ai/dsh-web', config: { searchProvider: 'explicit-user-provider' } })
    expect(reloaded.find(row => row.id === 'p7-company-models')).toMatchObject({ config: { requirePersonalLogin: true } })
    for (const id of ['ui-settings-account', 'message-feedback', 'ui-message-feedback']) {
      expect(reloaded.find(row => row.id === id)).toMatchObject({ disabled: true })
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})
