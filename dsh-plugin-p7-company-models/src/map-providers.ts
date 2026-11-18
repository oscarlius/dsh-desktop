import type { ApiKind, ModelConfigV1, P7Connection, ReasoningEfforts } from './contracts.js'

export const P7_PROVIDER_IDS: Record<ApiKind, string> = {
  'openai-completions': 'p7-company-chat',
  'openai-responses': 'p7-company-responses',
  'anthropic-messages': 'p7-company-messages',
}
export interface ManagedModelProfile { id: string; name: string; contextWindow: number; maxTokens: number; input: Array<'text' | 'image'>; reasoningEfforts?: ReasoningEfforts }
export interface ManagedProvider { id: string; api: ApiKind; baseURL: string; credentialRef: string; rejectRedirects: true; transport: 'sse'; models: ManagedModelProfile[] }
export function p7BaseURL(api: ApiKind, origin: string): string { return api === 'anthropic-messages' ? origin : `${origin}/v1` }
export function mapConfigToProviders(config: ModelConfigV1, connection: Pick<P7Connection, 'origin'> & { credentialRef: string }): ManagedProvider[] {
  if (!config.enabled || config.models.length === 0) return []
  return (Object.keys(P7_PROVIDER_IDS) as ApiKind[]).flatMap(api => {
    const models = config.models.filter(model => model.api === api).map(model => ({ id: model.id, name: model.displayName, contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens, input: [...model.inputModalities], ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }) }))
    return models.length ? [{ id: P7_PROVIDER_IDS[api], api, baseURL: p7BaseURL(api, connection.origin), credentialRef: connection.credentialRef, rejectRedirects: true, transport: 'sse', models }] : []
  })
}
