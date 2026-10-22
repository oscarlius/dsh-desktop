/** Secret-free status shared with the company settings page. */
export interface CompanyStatus {
  /** This client profile requires a valid personal Feishu session before company tools or models are available. */
  loginRequired: boolean
  phase: 'disconnected' | 'syncing' | 'ready' | 'stale' | 'unauthorized' | 'error'
  origin: string | null
  revision: string | null
  lastSyncedAt: number | null
  defaultModel: string | null
  models: {
    id: string; displayName: string
    api?: string; contextWindow?: number; maxOutputTokens?: number; inputModalities?: readonly string[]
  }[]
  /** Host registration snapshot; this is availability, never evidence of use in a conversation. */
  tools: {
    phase: 'syncing' | 'registered' | 'unavailable'
    tools: { name: string }[]
  }
  message: string | null
}
