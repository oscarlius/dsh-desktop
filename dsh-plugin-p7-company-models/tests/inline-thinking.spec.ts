import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { normalizeInlineThinking, splitInlineThinking } from '../src/inline-thinking.js'

const source = async function* (chunks: StreamChunk[]) { yield* chunks }
async function collect(chunks: StreamChunk[]) {
  const output: StreamChunk[] = []
  for await (const chunk of normalizeInlineThinking(source(chunks))) output.push(chunk)
  const assembler = new BlockAssembler()
  for (const chunk of output) assembler.push(chunk)
  return { output, assembler }
}
function reply(parts: string[]): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...parts.map(text => ({ type: 'text-delta' as const, index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: parts.join('') } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('P7 inline thinking normalization', () => {
  it('handles every tag split, emits native reasoning and retains the complete answer', async () => {
    const raw = '<think>计划🙂</think>完整答案'
    for (let split = 1; split < raw.length; split++) {
      const { assembler } = await collect(reply([raw.slice(0, split), raw.slice(split)]))
      expect(assembler.blocks()).toEqual([{ type: 'reasoning', text: '计划🙂' }, { type: 'text', text: '完整答案' }])
    }
    expect((await collect(reply([...raw]))).assembler.blocks()).toEqual([
      { type: 'reasoning', text: '计划🙂' }, { type: 'text', text: '完整答案' },
    ])
  })

  it.each([
    ['plain answer', [{ type: 'text', text: 'plain answer' }]],
    ['Use <think> literally', [{ type: 'text', text: 'Use <think> literally' }]],
    ['```html\n<think>example</think>\n```', [{ type: 'text', text: '```html\n<think>example</think>\n```' }]],
    ['<think>unfinished', [{ type: 'reasoning', text: 'unfinished' }]],
    ['<think>unfinished</thi', [{ type: 'reasoning', text: 'unfinished</thi' }]],
    ['<thi', [{ type: 'text', text: '<thi' }]],
    ['<think>one</think><think>two</think>answer', [{ type: 'reasoning', text: 'onetwo' }, { type: 'text', text: 'answer' }]],
    ['<think>plan</think>Example: `<think>literal</think>`', [{ type: 'reasoning', text: 'plan' }, { type: 'text', text: 'Example: `<think>literal</think>`' }]],
  ])('normalizes %s without losing content', async (raw, expected) => {
    expect((await collect(reply([raw]))).assembler.blocks()).toEqual(expected)
  })

  it.each(['ordinary answer', '<think>live thought'])('streams %s before the upstream finishes', async text => {
    let release!: () => void
    let finished = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const upstream = async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      await gate
      finished = true
    }
    const iterator = normalizeInlineThinking(upstream())[Symbol.asyncIterator]()
    try {
      const first = await Promise.race([iterator.next(), new Promise<never>((_, reject) => setTimeout(() => reject(Error('First tokens were buffered until completion')), 1500))])
      expect(first.value?.type).toBe('block-start')
      const second = await iterator.next()
      expect(second.value).toMatchObject({ type: text.startsWith('<think>') ? 'reasoning-delta' : 'text-delta', text: text.replace('<think>', '') })
      expect(finished).toBe(false)
    } finally { release(); await iterator.return?.() }
  })

  it('keeps unique native reasoning/tool indexes, usage and terminal failures after splitting', async () => {
    const usage = { inputTokens: 12, outputTokens: 8 }
    const input: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'native' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'native' } },
      ...reply(['<think>inline</think>answer']).slice(0, -1).map(chunk => 'index' in chunk ? { ...chunk, index: 1 } : chunk),
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'call1' as never, name: 'search', argumentsDelta: '{}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call1' as never, name: 'search', arguments: '{}' } },
      { type: 'usage', usage: usage as never },
      { type: 'finish', reason: { kind: 'max-tokens' }, replayState: { response: 'old-provider-response', blocks: ['native', 'inline-and-answer', 'tool'] } },
    ]
    const { output, assembler } = await collect(input)
    expect(assembler.blocks()).toEqual([{ type: 'reasoning', text: 'native' }, { type: 'reasoning', text: 'inline' }, { type: 'text', text: 'answer' }])
    expect(assembler.usage).toEqual(usage)
    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
    expect(output.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    const starts = output.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index)
    expect(new Set(starts).size).toBe(starts.length)
    expect(starts).toEqual([0, 1, 2, 3])
  })

  it('finalizes an interrupted thought without exposing tags or inventing an answer', async () => {
    const { assembler } = await collect([
      { type: 'text-delta', index: 0, text: '<think>partial thought' },
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Cancelled' } } },
    ])
    expect(assembler.interruptedBlocks()).toEqual([{ type: 'reasoning', text: 'partial thought' }])
    expect(assembler.finish.kind).toBe('aborted')
  })

  it('supports terminal-only text and leaves ordinary successful replay intact', async () => {
    expect((await collect([{ type: 'block-end', index: 2, block: { type: 'text', text: '<think>plan</think>answer' } }])).assembler.blocks()).toEqual([
      { type: 'reasoning', text: 'plan' }, { type: 'text', text: 'answer' },
    ])
    const replay = { response: { id: 'native' }, blocks: ['text'] }
    const { output } = await collect([...reply(['answer']).slice(0, -1), { type: 'finish', reason: { kind: 'stop' }, replayState: replay }])
    expect(output.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' }, replayState: replay })
  })

  it('uses the same lossless historical parser and preserves literal answer examples', () => {
    expect(splitInlineThinking('<think>old</think>Answer `<think>literal</think>`')).toEqual([
      { type: 'reasoning', text: 'old' }, { type: 'text', text: 'Answer `<think>literal</think>`' },
    ])
    expect(splitInlineThinking('<think>interrupted')).toEqual([{ type: 'reasoning', text: 'interrupted' }])
    expect(splitInlineThinking('Use <think> literally')).toBeUndefined()
  })
})
