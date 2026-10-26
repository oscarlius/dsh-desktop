import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { P7_PROVIDER_IDS } from './map-providers.js'

const COMPANY_PROVIDERS = new Set(Object.values(P7_PROVIDER_IDS))
const OPEN = '<think>'
const CLOSE = '</think>'
export type InlineThinkingSegment = { type: 'text' | 'reasoning'; text: string }

/** Only a leading model preamble is special. Once the answer starts, tags are literal. */
class InlineThinkingParser {
  private mode: 'prefix' | 'reasoning' | 'between' | 'text' = 'prefix'
  private pending = ''
  inline = false

  push(text: string): InlineThinkingSegment[] {
    this.pending += text
    const parts: InlineThinkingSegment[] = []
    const emit = (type: InlineThinkingSegment['type'], value: string) => {
      if (value) parts.push({ type, text: value })
    }
    while (this.pending) {
      if (this.mode === 'text') {
        emit('text', this.pending)
        this.pending = ''
      } else if (this.mode === 'reasoning') {
        const end = this.pending.indexOf(CLOSE)
        if (end !== -1) {
          emit('reasoning', this.pending.slice(0, end))
          this.pending = this.pending.slice(end + CLOSE.length)
          this.mode = 'between'
        } else {
          // Retain only a possible split closing marker, not the thinking stream.
          let suffix = Math.min(CLOSE.length - 1, this.pending.length)
          while (suffix > 0 && !CLOSE.startsWith(this.pending.slice(-suffix))) suffix--
          emit('reasoning', this.pending.slice(0, this.pending.length - suffix))
          this.pending = suffix ? this.pending.slice(-suffix) : ''
          break
        }
      } else {
        const whitespace = /^\s+/u.exec(this.pending)?.[0] ?? ''
        emit('text', whitespace)
        this.pending = this.pending.slice(whitespace.length)
        if (!this.pending) break
        if (this.pending.startsWith(OPEN)) {
          this.inline = true
          this.mode = 'reasoning'
          this.pending = this.pending.slice(OPEN.length)
        } else if (OPEN.startsWith(this.pending)) {
          break
        } else {
          this.mode = 'text'
        }
      }
    }
    return parts
  }

  finish(): InlineThinkingSegment[] {
    const text = this.pending
    this.pending = ''
    return text ? [{ type: this.mode === 'reasoning' ? 'reasoning' : 'text', text }] : []
  }
}

/** Presentation-only equivalent for persisted replies, including interrupted thoughts. */
export function splitInlineThinking(text: string): InlineThinkingSegment[] | undefined {
  const parser = new InlineThinkingParser()
  const parts = [...parser.push(text), ...parser.finish()]
  if (!parser.inline) return undefined
  const merged: InlineThinkingSegment[] = []
  for (const part of parts) {
    const previous = merged.at(-1)
    if (previous?.type === part.type) previous.text += part.text
    else merged.push({ ...part })
  }
  return merged
}

interface TextState {
  parser: InlineThinkingParser
  rawLength: number
  active?: { index: number; type: 'text' | 'reasoning'; text: string }
}

/** Emit native blocks as tokens arrive; indexes stay unique across text, reasoning and tools. */
export async function* normalizeInlineThinking(source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const states = new Map<number, TextState>()
  const nativeIndexes = new Map<number, number>()
  let nextIndex = 0
  let transformed = false
  const nativeIndex = (index: number) => {
    if (!nativeIndexes.has(index)) nativeIndexes.set(index, nextIndex++)
    return nativeIndexes.get(index)!
  }
  const stateFor = (index: number) => {
    let state = states.get(index)
    if (!state) { state = { parser: new InlineThinkingParser(), rawLength: 0 }; states.set(index, state) }
    return state
  }
  function* emit(state: TextState, parts: InlineThinkingSegment[]): Generator<StreamChunk> {
    for (const part of parts) {
      if (state.active?.type !== part.type) {
        if (state.active) yield { type: 'block-end', index: state.active.index, block: { type: state.active.type, text: state.active.text } }
        state.active = { index: nextIndex++, type: part.type, text: '' }
        yield { type: 'block-start', index: state.active.index, blockType: part.type }
      }
      state.active!.text += part.text
      yield { type: part.type === 'text' ? 'text-delta' : 'reasoning-delta', index: state.active!.index, text: part.text }
    }
    transformed ||= state.parser.inline
  }
  function* close(index: number, original?: Extract<StreamChunk, { type: 'block-end' }>): Generator<StreamChunk> {
    const state = states.get(index)
    if (!state) return
    yield* emit(state, state.parser.finish())
    if (state.active) {
      const block = !state.parser.inline && original?.block.type === 'text'
        ? original.block : { type: state.active.type, text: state.active.text }
      yield { type: 'block-end', index: state.active.index, block }
    }
    states.delete(index)
  }
  for await (const chunk of source) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      stateFor(chunk.index)
    } else if (chunk.type === 'text-delta') {
      const state = stateFor(chunk.index)
      state.rawLength += chunk.text.length
      yield* emit(state, state.parser.push(chunk.text))
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      const state = stateFor(chunk.index)
      // Support a provider that emits only the assembled terminal block, too.
      if (chunk.block.text.length > state.rawLength) yield* emit(state, state.parser.push(chunk.block.text.slice(state.rawLength)))
      yield* close(chunk.index, chunk)
    } else if (chunk.type === 'finish') {
      for (const index of states.keys()) yield* close(index)
      // Old per-block replay bytes cannot describe the normalized block list.
      yield transformed ? { type: 'finish', reason: chunk.reason } : chunk
    } else if ('index' in chunk) {
      yield { ...chunk, index: nativeIndex(chunk.index) }
    } else {
      yield chunk
    }
  }
  for (const index of states.keys()) yield* close(index)
}

/** Corporate routes only; official/personal adapters and native reasoning remain intact. */
export function installInlineThinkingNormalizer(ctx: Context): void {
  ctx.on('llm/stream', (options: GenerateOptions, next) => COMPANY_PROVIDERS.has(options.provider)
    ? normalizeInlineThinking(next()) : next())
}
