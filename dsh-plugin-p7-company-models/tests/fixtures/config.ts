export const config = (changes: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  revision: 'revision-1',
  enabled: true,
  defaultModel: 'admin-alias',
  models: [{ id: 'admin-alias', displayName: 'Administrator supplied name', api: 'openai-completions', contextWindow: 4096, maxOutputTokens: 1024, inputModalities: ['text'], streaming: true, tools: true }],
  ...changes,
})
