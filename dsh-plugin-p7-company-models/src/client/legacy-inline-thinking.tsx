import { createElement, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { splitInlineThinking } from '../inline-thinking.js'

type AssistantBlock = { readonly kind: string; readonly text?: string; readonly [key: string]: unknown }
type AssistantNodeLike = {
  readonly data: { readonly status: 'running' | 'settled' | 'interrupted'; readonly blocks: readonly AssistantBlock[] }
}

/**
 * Presentation-only repair for historical, already completed messages. Session
 * events stay untouched; future streams are normalized at the host boundary.
 */
export function normalizeLegacyAssistantNode<T extends AssistantNodeLike>(node: T): T {
  if (node.data.status === 'running') return node
  let changed = false
  const blocks: AssistantBlock[] = []
  for (const block of node.data.blocks) {
    if (block.kind !== 'text' || typeof block.text !== 'string') { blocks.push(block); continue }
    const segments = splitInlineThinking(block.text)
    if (segments === undefined) { blocks.push(block); continue }
    changed = true
    blocks.push(...segments.filter(segment => segment.text.length > 0)
      .map(segment => ({ ...block, kind: segment.type, text: segment.text })))
  }
  return changed ? { ...node, data: { ...node.data, blocks } } : node
}

function wrapper(original: ComponentType<any>): ComponentType<any> {
  return function LegacyInlineThinkingAssistant(props: { node: AssistantNodeLike; groupPart?: string }) {
    const node = normalizeLegacyAssistantNode(props.node)
    // The persisted group tree classified this raw text as a response before
    // this presentation adapter split it. Let the official renderer handle
    // both normalized blocks in that one legacy row.
    return createElement(original, { ...props, node, ...(node === props.node || props.groupPart !== 'response' ? {} : { groupPart: undefined }) })
  }
}

type StoredAssistantEntry = { component: ComponentType<any>; options: { key?: string } }

/**
 * Decorate the live shipped entry in place. The Slot API has no public
 * decorator primitive, and a shadow registration cannot redeclare the
 * original entry's owned children. Retaining this entry preserves its
 * renderer-supplied renderSlot, locale, store, and child declarations.
 */
export function installLegacyInlineThinkingDisplay(ctx: Context): () => void {
  const slot = 'conversation.chat.node'
  return ctx.slots.inject(slot as never, () => {
    const decorated = new Map<StoredAssistantEntry, { readonly component: ComponentType<any>; readonly wrapper: ComponentType<any> }>()
    const install = () => {
      const original = ctx.slots.entriesOfSlot(slot as never)
        .filter(entry => entry.options.key === 'assistant-step')
        [0] as StoredAssistantEntry | undefined
      if (original === undefined) return
      if (decorated.has(original)) return
      const component = original.component
      const decoratedComponent = wrapper(component)
      original.component = decoratedComponent
      decorated.set(original, { component, wrapper: decoratedComponent })
    }
    const unsubscribe = ctx.slots.subscribe(slot as never, install)
    install()
    return () => {
      unsubscribe()
      for (const [entry, original] of decorated) if (entry.component === original.wrapper) entry.component = original.component
    }
  })
}
