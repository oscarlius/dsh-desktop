/** Secret-free status shared with the company settings page. */
export interface CompanyStatus {
  phase: 'disconnected' | 'syncing' | 'ready' | 'stale' | 'unauthorized' | 'error'
  origin: string | null
  revision: string | null
  lastSyncedAt: number | null
  defaultModel: string | null
  models: {
    id: string; displayName: string
    api?: string; contextWindow?: number; maxOutputTokens?: number; inputModalities?: readonly string[]
  }[]
  message: string | null
}
