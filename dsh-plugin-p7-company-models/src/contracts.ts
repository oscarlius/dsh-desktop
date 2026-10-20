export const P7_API_KINDS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
export type ApiKind = (typeof P7_API_KINDS)[number]
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
export type ReasoningEfforts = false | Partial<Record<ReasoningEffort, string | null>>

export interface ModelDefinition {
  id: string
  displayName: string
  api: ApiKind
  contextWindow: number
  maxOutputTokens: number
  inputModalities: Array<'text' | 'image'>
  streaming: true
  tools: true
  reasoningEfforts?: ReasoningEfforts
}

export interface ModelConfigV1 {
  schemaVersion: 1
  revision: string
  enabled: boolean
  defaultModel: string | null
  models: ModelDefinition[]
}

export interface P7Connection {
  origin: string
  key: string
}

export interface P7Snapshot {
  config: ModelConfigV1
  etag: string
  appliedAt: number
}
