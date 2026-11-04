/**
 * Profile-loadable recovery for existing P7 Agents with oversized history.
 * Uses the public llm/stream routing waterfall; never changes prepared Agent
 * requests, conversation history, provider capacities, or credentials.
 */
import { writeFileSync } from 'node:fs'

export const name = 'p7-compaction-summary-routing'

const LOCAL_PROVIDERS = new Set(['p7-company-chat', 'p7-company-responses', 'p7-company-messages'])
const LOCAL_MODELS = new Set(['DeepSeek-V4.1-Flash', 'Qwen3.8-Flash-Next'])
const SUMMARY_PROVIDER = 'p7-company-chat'
const SUMMARY_MODEL = 'gemini-3.8-flash-tiered'

function recordState(phase) {
  // The installed profile copy exposes a small local receipt without logging
  // prompts or requiring a model call. Repository tests create no receipt.
  if (!new URL(import.meta.url).pathname.includes('/p7-compat/')) return
  try {
    writeFileSync(new URL('./p7-compaction-summary-ready.json', import.meta.url), JSON.stringify({
      module: import.meta.url, phase, at: new Date().toISOString(), primaryContextWindow: 262144,
    }))
  } catch { /* A diagnostic write never changes a model call's outcome. */ }
}

/** Existing Agents retain preset generations, so install at the Host LLM seam. */
export function apply(ctx) {
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== 'compaction'
      || !LOCAL_PROVIDERS.has(options.provider)
      || !LOCAL_MODELS.has(options.model)) {
      yield* next()
      return
    }
    // Re-enter once with a non-local model. The guard above delegates the
    // nested call directly, resulting in exactly one provider HTTP request.
    // Keep the same cancellation signal, payload, tools and token budget.
    ctx.logger.info('P7 compaction summary: using existing Gemini backup; primary local route unchanged')
    recordState('summary-routed')
    // The public waterfall binds `this` to the actual LlmRuntime. This also
    // works for retained preset generations without depending on the profile
    // plugin's service lookup scope.
    yield* this.stream({ ...options, provider: SUMMARY_PROVIDER, model: SUMMARY_MODEL })
  })
  recordState('ready')
  ctx.logger.warn('P7 compaction recovery activated: summaries may use Gemini; primary local capacity remains 262144')
}
