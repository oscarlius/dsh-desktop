import { P7_API_KINDS, REASONING_EFFORTS, type ModelConfigV1, type ModelDefinition, type ReasoningEfforts } from './contracts.js'

const MAX_RESPONSE_BYTES = 256 * 1024
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new ConfigValidationError(message) }
const keysExactly = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  for (const key of Object.keys(value)) assert(required.includes(key) || optional.includes(key), `unknown field: ${key}`)
  for (const key of required) assert(key in value, `missing field: ${key}`)
}
const boundedString = (value: unknown, label: string, max: number, pattern?: RegExp): string => {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max, `${label} must be a non-empty string up to ${max} characters`)
  assert(!pattern || pattern.test(value), `${label} has an invalid format`)
  return value
}
export class ConfigValidationError extends Error { constructor(message: string) { super(message); this.name = 'ConfigValidationError' } }

function validateReasoning(value: unknown): ReasoningEfforts | undefined {
  if (value === undefined) return undefined
  if (value === false) return false
  assert(isRecord(value), 'reasoningEfforts must be false or an object')
  const entries = Object.entries(value)
  assert(entries.length > 0, 'reasoningEfforts cannot be empty')
  for (const [key, wire] of entries) {
    assert((REASONING_EFFORTS as readonly string[]).includes(key), `unknown reasoning effort: ${key}`)
    assert(wire === null || (typeof wire === 'string' && wire.length > 0 && wire.length <= 64), `invalid reasoning effort wire value: ${key}`)
  }
  return value as ReasoningEfforts
}
function validateModel(input: unknown): ModelDefinition {
  assert(isRecord(input), 'model must be an object')
  keysExactly(input, ['id', 'displayName', 'api', 'contextWindow', 'maxOutputTokens', 'inputModalities', 'streaming', 'tools'], ['reasoningEfforts'])
  const id = boundedString(input.id, 'model id', 128, /^[^\s\u0000-\u001f\u007f]+$/)
  const displayName = boundedString(input.displayName, 'displayName', 160)
  assert(typeof input.api === 'string' && (P7_API_KINDS as readonly string[]).includes(input.api), 'unknown api')
  assert(Number.isInteger(input.contextWindow) && (input.contextWindow as number) > 0, 'contextWindow must be a positive integer')
  assert(Number.isInteger(input.maxOutputTokens) && (input.maxOutputTokens as number) > 0 && (input.maxOutputTokens as number) <= (input.contextWindow as number), 'maxOutputTokens must be positive and not exceed contextWindow')
  assert(Array.isArray(input.inputModalities) && input.inputModalities.length >= 1 && input.inputModalities.length <= 2, 'inputModalities must contain one or two entries')
  assert(new Set(input.inputModalities).size === input.inputModalities.length && input.inputModalities.includes('text') && input.inputModalities.every(value => value === 'text' || value === 'image'), 'inputModalities must uniquely include text and only supported modalities')
  assert(input.streaming === true && input.tools === true, 'streaming and tools must be true')
  const reasoningEfforts = validateReasoning(input.reasoningEfforts)
  return { id, displayName, api: input.api as ModelDefinition['api'], contextWindow: input.contextWindow as number, maxOutputTokens: input.maxOutputTokens as number, inputModalities: input.inputModalities as ModelDefinition['inputModalities'], streaming: true, tools: true, ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }) }
}
export function validateModelConfig(input: unknown, encodedBytes?: number): ModelConfigV1 {
  if (encodedBytes !== undefined) assert(encodedBytes <= MAX_RESPONSE_BYTES, 'response exceeds 256 KiB')
  assert(isRecord(input), 'model config must be an object')
  keysExactly(input, ['schemaVersion', 'revision', 'enabled', 'defaultModel', 'models'])
  assert(input.schemaVersion === 1, 'unsupported schemaVersion')
  const revision = boundedString(input.revision, 'revision', 128, /^[A-Za-z0-9._:-]+$/)
  assert(typeof input.enabled === 'boolean', 'enabled must be boolean')
  assert(input.defaultModel === null || (typeof input.defaultModel === 'string' && input.defaultModel.length > 0 && input.defaultModel.length <= 128), 'defaultModel must be null or a non-empty string')
  assert(Array.isArray(input.models) && input.models.length <= 128, 'models must be an array of at most 128 items')
  const models = input.models.map(validateModel)
  assert(new Set(models.map(model => model.id)).size === models.length, 'model aliases must be unique')
  if (!input.enabled || models.length === 0) assert(input.defaultModel === null, 'disabled or empty config must have defaultModel null')
  if (models.length > 0) {
    assert(input.enabled, 'non-empty config must be enabled')
    assert(typeof input.defaultModel === 'string' && models.some(model => model.id === input.defaultModel), 'defaultModel must be a model alias')
  }
  return { schemaVersion: 1, revision, enabled: input.enabled, defaultModel: input.defaultModel, models }
}
export { MAX_RESPONSE_BYTES }
