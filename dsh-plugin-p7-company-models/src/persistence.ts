import { readFile, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { P7Snapshot } from './contracts.js'
import { validateModelConfig } from './validate-config.js'
import { validateP7Origin } from './p7-client.js'
import { P7_PROVIDER_IDS } from './map-providers.js'

export interface PersistedCompanyState { version: 1; origin: string | null; ownedIds: string[]; snapshot?: P7Snapshot }
const empty = (): PersistedCompanyState => ({ version: 1, origin: null, ownedIds: [] })
/** The file contains only origin, ownership and a validated non-secret catalog. */
export class CompanyPersistence {
  constructor(private readonly path: string) {}
  async load(): Promise<PersistedCompanyState> {
    try {
      if ((await stat(this.path)).size > 300 * 1024) throw new Error('Invalid saved company configuration.')
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid saved company configuration.')
      const value = raw as Record<string, unknown>
      if (value.version !== 1 || !(value.origin === null || typeof value.origin === 'string') || !Array.isArray(value.ownedIds)
        || !value.ownedIds.every((id: unknown) => typeof id === 'string' && Object.values(P7_PROVIDER_IDS).includes(id))) throw new Error('Invalid saved company configuration.')
      const state: PersistedCompanyState = { version: 1, origin: value.origin === null ? null : validateP7Origin(value.origin), ownedIds: [...value.ownedIds] }
      if (value.snapshot !== undefined) {
        if (typeof value.snapshot !== 'object' || value.snapshot === null || Array.isArray(value.snapshot)) throw new Error('Invalid saved company snapshot.')
        const snapshot = value.snapshot as Record<string, unknown>
        const config = validateModelConfig(snapshot.config)
        if (snapshot.etag !== `"${config.revision}"` || typeof snapshot.appliedAt !== 'number' || !Number.isFinite(snapshot.appliedAt)) throw new Error('Invalid saved company snapshot.')
        state.snapshot = { config, etag: snapshot.etag, appliedAt: snapshot.appliedAt }
      }
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw new Error('Saved P7 settings could not be read. Reconnect P7 to repair them.')
    }
  }
  async save(state: PersistedCompanyState): Promise<void> {
    await writeFileAtomic(this.path, JSON.stringify(state), { mode: 0o600, dirMode: 0o700 })
  }
}
