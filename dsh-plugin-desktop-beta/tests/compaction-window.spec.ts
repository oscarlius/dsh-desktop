import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { LlmAdapter, ToolCallId, createMessage, createToolResultMessage, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

const route = { provider: 'windowed-company-provider', model: 'windowed-company-model' }
const contextWindow = 4096

class WindowAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  rejected = 0

  constructor(private readonly rejectFirst: boolean) { super() }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow } }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const characters = options.messages.flatMap(message => message.content)
      .reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : JSON.stringify(block).length), 0)
    const tooLarge = Math.ceil(characters / 4) + (options.maxTokens ?? 0) > contextWindow
    if ((this.rejectFirst && this.calls.length === 1) || tooLarge) {
      this.rejected++
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'adapter context limit' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '- checkpoint fact' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function setup(rejectFirst = false) {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const adapter = new WindowAdapter(rejectFirst)
  ctx.llm.registerAdapter([route.provider], adapter)
  return { adapter, engine: new BasicCompactionEngine(ctx, { maxTokens: 256 }) }
}

function toolSession(resultText: string) {
  const session = Session.create(SessionId('window-regression'))
  const callId = ToolCallId('large-result')
  const step = { turn: 1, step: 1 }
  const visible = { surfaceOp: 'append' } as const
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'preserve this original request' }], source: { kind: 'user' },
  }), visible)
  session.append('step/start', step)
  session.append('request/header', { header: { config: route }, reason: 'initial' })
  session.append('assistant/message', {
    ...step, stream: [], message: createMessage({
      role: 'assistant', source: { kind: 'model', ...route },
      content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
    }),
  }, visible)
  session.append('tool/call', { ...step, callId, name: 'read', arguments: '{}' })
  session.append('tool/result', {
    ...step, message: createToolResultMessage({ callId, content: [{ type: 'text', text: resultText }], isError: false }),
  }, visible)
  session.append('step/end', step)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  return session
}

function compact(engine: BasicCompactionEngine, session: Session) {
  const owner = { session, options: route } as Parameters<BasicCompactionEngine['compactIfNeeded']>[0]
  return engine.compactRegion(session.surface.nodes[0]!, session.surface.nodes.at(-1)!, owner)
}

describe('company compaction summary window', () => {
  it('uses one request when the original envelope fits', async () => {
    const { adapter, engine } = setup()
    await compact(engine, toolSession('small tool output '.repeat(100)))
    expect(adapter.rejected).toBe(0)
    expect(adapter.calls).toHaveLength(1)
  })

  it('retains the original tool result and uses the new checkpoint for subsequent messages', async () => {
    const { adapter, engine } = setup()
    const session = toolSession('tool output '.repeat(3000))
    const original = [...session.snapshotEvents()]
    await compact(engine, session)
    expect(adapter.calls.length).toBeGreaterThan(1)
    expect(session.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const messages = session.deriveMessages()
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'continue' }])
    expect(messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('checkpoint fact')))).toBe(true)
  })

  it('shrinks the envelope after a provider-confirmed overflow', async () => {
    const { adapter, engine } = setup(true)
    const session = toolSession('retryable tool output '.repeat(120))
    await compact(engine, session)
    expect(adapter.rejected).toBe(1)
    expect(adapter.calls.length).toBeGreaterThan(1)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/end')).toBe(true)
  })
})
