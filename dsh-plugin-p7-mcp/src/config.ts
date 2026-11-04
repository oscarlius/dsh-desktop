import Schema from '@deepseek-ai/schemastery'

export interface Config {
  mode?: 'eager' | 'on-demand'
  maxLoadedTools?: number
  maxSchemaBytes?: number
  searchLimit?: number
}

export interface ResolvedConfig {
  readonly mode: 'eager' | 'on-demand'
  readonly maxLoadedTools: number
  readonly maxSchemaBytes: number
  readonly searchLimit: number
}

export const Config = Schema.object({
  mode: Schema.union(['eager', 'on-demand']).default('eager'),
  maxLoadedTools: Schema.natural().min(1).max(128).default(12),
  maxSchemaBytes: Schema.natural().min(512).max(1_048_576).default(32_768),
  searchLimit: Schema.natural().min(1).max(10).default(5),
})

/** Also validate direct callers that do not pass through the Loader schema. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const mode = config.mode ?? 'eager'
  if (mode !== 'eager' && mode !== 'on-demand') throw new TypeError('Invalid P7 MCP loading mode')
  const bounded = (value: number | undefined, fallback: number, min: number, max: number, field: string): number => {
    const result = value ?? fallback
    if (!Number.isInteger(result) || result < min || result > max) throw new RangeError(`Invalid P7 MCP ${field}`)
    return result
  }
  return {
    mode,
    maxLoadedTools: bounded(config.maxLoadedTools, 12, 1, 128, 'maxLoadedTools'),
    maxSchemaBytes: bounded(config.maxSchemaBytes, 32_768, 512, 1_048_576, 'maxSchemaBytes'),
    searchLimit: bounded(config.searchLimit, 5, 1, 10, 'searchLimit'),
  }
}
