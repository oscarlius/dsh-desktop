import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompanyPersistence } from '../src/persistence.js'
import { P7_PROVIDER_IDS } from '../src/map-providers.js'
import { config } from './fixtures/config.js'

const tempState = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p7-company-'))
  return { directory, path: join(directory, 'state.json') }
}

describe('CompanyPersistence', () => {
  it('round trips secret-free origin, ownership, and validated snapshot', async () => {
    const temp = await tempState()
    try {
      const persistence = new CompanyPersistence(temp.path)
      await persistence.save({ version: 1, origin: 'https://p7.example', ownedIds: [P7_PROVIDER_IDS['openai-completions']], snapshot: { config: config() as never, etag: '"revision-1"', appliedAt: 42 } })
      const raw = await readFile(temp.path, 'utf8')
      expect(raw).not.toContain('p7k_')
      expect(await persistence.load()).toMatchObject({ origin: 'https://p7.example', ownedIds: [P7_PROVIDER_IDS['openai-completions']], snapshot: { etag: '"revision-1"' } })
    } finally { await rm(temp.directory, { recursive: true, force: true }) }
  })

  it('returns an empty state for an absent file and rejects malformed or oversized state', async () => {
    const temp = await tempState()
    try {
      const persistence = new CompanyPersistence(temp.path)
      await expect(persistence.load()).resolves.toEqual({ version: 1, origin: null, ownedIds: [] })
      await writeFile(temp.path, '{bad')
      await expect(persistence.load()).rejects.toThrow('could not be read')
      await writeFile(temp.path, 'x'.repeat(300 * 1024 + 1))
      await expect(persistence.load()).rejects.toThrow('could not be read')
    } finally { await rm(temp.directory, { recursive: true, force: true }) }
  })

  it('persists only the non-secret personal-mode opt-in', async () => {
    const temp = await tempState()
    try {
      const persistence = new CompanyPersistence(temp.path)
      await persistence.save({ version: 1, origin: 'https://p7.example', ownedIds: [], personalMode: true })
      const raw = await readFile(temp.path, 'utf8')
      expect(raw).toContain('"personalMode":true')
      expect(raw).not.toMatch(/access|refresh|token/i)
      await expect(persistence.load()).resolves.toMatchObject({ personalMode: true })
    } finally { await rm(temp.directory, { recursive: true, force: true }) }
  })
})
