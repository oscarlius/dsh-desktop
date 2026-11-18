import { describe, expect, it } from 'vitest'
import { installLegacyInlineThinkingDisplay, normalizeLegacyAssistantNode } from '../src/client/legacy-inline-thinking.js'

describe('legacy inline thinking display', () => {
  it('splits only a settled historical inline preamble for the shipped assistant renderer', () => {
    const node = {
      data: {
        status: 'settled' as const,
        blocks: [{ kind: 'text' as const, text: '<think>old thought</think>Old answer' }],
      },
    }
    expect(normalizeLegacyAssistantNode(node).data.blocks).toEqual([
      { kind: 'reasoning', text: 'old thought' },
      { kind: 'text', text: 'Old answer' },
    ])
    expect(node.data.blocks[0]?.text).toBe('<think>old thought</think>Old answer')
  })

  it('leaves live and ordinary tag examples untouched while recovering an interrupted historical thought', () => {
    const cases = [
      { status: 'running' as const, text: '<think>live</think>answer' },
      { status: 'settled' as const, text: 'Use <think> literally' },
    ]
    for (const item of cases) {
      const node = { data: { status: item.status, blocks: [{ kind: 'text' as const, text: item.text }] } }
      expect(normalizeLegacyAssistantNode(node)).toBe(node)
    }
    const interrupted = { data: { status: 'interrupted' as const, blocks: [{ kind: 'text' as const, text: '<think>unfinished' }] } }
    expect(normalizeLegacyAssistantNode(interrupted).data.blocks).toEqual([{ kind: 'reasoning', text: 'unfinished' }])
  })

  it('preserves native reasoning, tools, and the historical answer block unchanged', () => {
    const nativeReasoning = { kind: 'reasoning', text: 'native thought' }
    const tool = { kind: 'tool-call', callId: 'c1', name: 'read', argsRaw: '{}' }
    const answer = { kind: 'text', text: 'saved answer' }
    const node = { data: { status: 'settled' as const, blocks: [nativeReasoning, tool, answer] } }
    expect(normalizeLegacyAssistantNode(node)).toBe(node)
    expect(node.data.blocks).toEqual([nativeReasoning, tool, answer])
  })

  it('decorates the active shipped entry without taking ownership of its child slots, and restores it on teardown', () => {
    const children = { child: { kind: 'single', scope: 'session' } }
    const inject = () => ({ hooks: {} })
    const original = { component: () => null, options: { key: 'assistant-step', priority: 100 }, children, inject, locale: 'chat' }
    const originalComponent = original.component
    let unsubscribed = false
    let active: any[] = [original]
    let notify: (() => void) | undefined
    const slots = {
      inject: (_name: string, callback: () => () => void) => callback(),
      entriesOfSlot: () => active,
      subscribe: (_name: string, callback: () => void) => { notify = callback; return () => { unsubscribed = true } },
    }
    const dispose = installLegacyInlineThinkingDisplay({ slots } as never)
    expect(original.children).toBe(children)
    expect(original.inject).toBe(inject)
    expect(original.locale).toBe('chat')
    expect(original.component).not.toBe(originalComponent)
    const node = { data: { status: 'settled' as const, blocks: [{ kind: 'text', text: '<think>saved</think>answer' }] } }
    const rendered = (original.component as any)({ node, groupPart: 'response' })
    expect(rendered.props.node.data.blocks).toEqual([
      { kind: 'reasoning', text: 'saved' }, { kind: 'text', text: 'answer' },
    ])
    expect(rendered.props.groupPart).toBeUndefined()
    const replacement = { component: () => null, options: { key: 'assistant-step', priority: 50 } }
    const replacementComponent = replacement.component
    active = [replacement]
    notify?.()
    expect(replacement.component).not.toBeTypeOf('undefined')
    dispose()
    expect(unsubscribed).toBe(true)
    expect(original.component).toBe(originalComponent)
    expect(replacement.component).toBe(replacementComponent)
  })
})
