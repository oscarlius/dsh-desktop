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
  if (!new URL(import.meta.url).pathname.includes('/p7-compat/')) return
  try {
    writeFileSync(new URL('./p7-compaction-summary-ready.json', import.meta.url), JSON.stringify({
      module: import.meta.url, phase, at: new Date().toISOString(),
      summaryPolicy: 'advertised-gemini-or-original-local-route',
    }))
  } catch { /* A diagnostic write never changes a model call's outcome. */ }
}

export function apply(ctx) {
  ctx.on('llm/stream', async function* (options, next) {
    const isLocalP7 = LOCAL_PROVIDERS.has(options.provider) && LOCAL_MODELS.has(options.model)
    if (options.purpose === 'compaction' && isLocalP7) {
      if (options.signal?.aborted) {
        yield* next()
        return
      }
      // Model discovery is the public runtime authority: do not manufacture a
      // route when this installed profile has no Gemini summary model.
      const models = await this.listModels(SUMMARY_PROVIDER)
      if (models.some((model) => model.id === SUMMARY_MODEL)) {
        ctx.logger.info('P7 compaction summary: using available Gemini backup; primary local route unchanged')
        recordState('summary-routed')
        yield* this.stream({ ...options, provider: SUMMARY_PROVIDER, model: SUMMARY_MODEL })
        return
      }
      recordState('summary-fallback-local')
    } else if (!isLocalP7) {
      yield* next()
      return
    }

    let sawVisibleText = false
    let outputTokens = 0
    const syntheticOverflow = `pi-ai detected context overflow for model "${options.model}"`
    for await (const chunk of next()) {
      if (chunk.type === 'text-delta' && chunk.text.trim().length > 0) sawVisibleText = true
      if (chunk.type === 'usage') outputTokens = Math.max(outputTokens, chunk.usage.outputTokens)
      if (chunk.type === 'finish'
        && chunk.reason.kind === 'error'
        && chunk.reason.failure.code === 'CONTEXT_WINDOW_EXCEEDED'
        && chunk.reason.failure.message === syntheticOverflow
        && sawVisibleText
        && outputTokens > 0
        && !options.signal?.aborted) {
        yield { ...chunk, reason: { kind: 'stop' } }
      } else {
        yield chunk
      }
    }
  })
  recordState('ready')
  ctx.logger.warn('P7 compaction recovery activated: summaries use Gemini only when the installed catalog advertises it')
}
