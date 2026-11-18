// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { en, zh, type CompanySettingsLocaleKey } from '../src/client/locales.js'
import { createCompanyToolTitleStore, installCompanyToolUpdateDisplay, withCompanyToolNames } from '../src/client/tool-update-display.js'

const names = ['gildata__FinQuery', 'search__web_search', 'weknora__ask', 'weknora__grep_chunks', 'weknora__list_documents'].map(name => `mcp__p7__${name}`)
const labels = ['聚源金融数据查询', '互联网搜索', '公司知识问答', '知识片段文本检索', '知识文档目录']
const companyT = (key: CompanySettingsLocaleKey) => zh[key]

describe('company tool update labels', () => {
  it.each(['message', 'layout'])('localizes %s additions/removals and single-tool notices without mutating parameters', prefix => {
    const translate = vi.fn((key: string, params?: Record<string, unknown>) => `${key}: ${String(params?.names ?? params?.name)}`)
    const t = withCompanyToolNames(translate, companyT)
    const params = Object.freeze({ names: names.join(', '), count: 5 })
    for (const action of ['Added', 'Removed']) {
      expect(t(`${prefix}.tools${action}`, params)).toBe(`${prefix}.tools${action}: ${labels.join(', ')}`)
      expect(t(`${prefix}.tool${action}`, { name: names[0] })).toBe(`${prefix}.tool${action}: ${labels[0]}`)
    }
    expect(params.names).toBe(names.join(', '))
    expect(translate.mock.calls[0]?.[1]).toEqual({ names: labels.join(', '), count: 5 })
  })

  it('follows the current locale, hides unknown company identifiers and preserves unrelated messages and counts', () => {
    let locale: 'zh' | 'en' = 'zh'
    const translate = vi.fn((key: string, params?: Record<string, unknown>) => `${key}: ${String(params?.names ?? params?.name)}`)
    const t = withCompanyToolNames(translate, key => ({ zh, en })[locale][key])
    const unknown = 'mcp__p7__future__inspect_status'
    const params = { names: `${names[1]}, ${unknown}, read_file` }
    expect(t('message.toolsAdded', params)).toContain('互联网搜索, 公司工具, read_file')
    expect(t('tool.displayName', { name: names[2] })).toBe('公司知识问答')
    expect(t('tool.displayName', { name: unknown })).toBe('公司工具')
    expect(t('tool.displayName', { name: 'read_file' })).toBe('read_file')
    locale = 'en'
    expect(t('message.toolsAdded', params)).toContain('Web search, Company tool, read_file')
    t('message.contextInjection', params)
    expect(translate.mock.calls.at(-1)?.[1]).toBe(params)
    const counts = { added: 5, removed: 0 }
    t('layout.toolsChanged', counts)
    expect(translate.mock.calls.at(-1)?.[1]).toBe(counts)
  })

  it('uses the current public P7 title for an otherwise unknown company tool in trajectory labels', () => {
    const unknown = 'mcp__p7__demo__fixture_echo'
    const titles = new Map([[unknown, '测试知识问答']])
    const translate = (key: string, params?: Record<string, unknown>) => `${key}: ${String(params?.name ?? params?.names)}`
    const t = withCompanyToolNames(translate, companyT, titles)
    expect(t('tool.displayName', { name: unknown })).toBe('测试知识问答')
    expect(t('message.toolAdded', { name: unknown })).toBe('message.toolAdded: 测试知识问答')
    titles.clear()
    expect(t('tool.displayName', { name: unknown })).toBe('公司工具')
  })

  it('notifies mounted displays only when public tool titles change or clear', () => {
    const store = createCompanyToolTitleStore(); const listener = vi.fn(); store.subscribe(listener)
    store.replace([{ name: 'mcp__p7__demo__fixture_echo', title: '测试知识问答' }])
    store.replace([{ name: 'mcp__p7__demo__fixture_echo', title: '测试知识问答' }])
    store.replace([])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.titles.size).toBe(0)
  })

  it('decorates both shipped surfaces, preserves source data and slot ownership, and restores replacements on unload', () => {
    const children = { child: { kind: 'single', scope: 'session' } }
    const inject = () => ({ hooks: {} })
    const surface = ({ t }: { t: (key: string, params?: Record<string, unknown>) => string }) => createElement('span', null, t('tool.displayName', { name: names[0] }))
    const chat = { component: surface, options: { key: 'context' }, children, inject, locale: 'chat' }
    const trajectory = { component: surface, options: { id: 'trajectory' } }
    const unrelated = { component: () => null, options: { key: 'assistant-step' } }
    const originalChat = chat.component, originalTrajectory = trajectory.component, originalUnrelated = unrelated.component
    const entries = new Map<string, any[]>([['conversation.chat.node', [unrelated, chat]], ['conversation.view', [trajectory]]])
    const listeners = new Map<string, () => void>()
    const slots = {
      inject: (_slot: string, setup: () => () => void) => setup(),
      entriesOfSlot: (slot: string) => entries.get(slot),
      subscribe: (slot: string, listener: () => void) => { listeners.set(slot, listener); return () => listeners.delete(slot) },
    }
    const dispose = installCompanyToolUpdateDisplay({ slots, locale: { bind: () => companyT } } as never)
    const node = Object.freeze({ data: Object.freeze({ content: Object.freeze(names.map(toolName => Object.freeze({ type: 'tool-addition', toolName }))) }) })
    const t = (_key: string, params?: Record<string, unknown>) => String(params?.names)
    for (const entry of [chat, trajectory]) {
      const rendered = render(createElement(entry.component as any, { node, t, hooks: inject().hooks }))
      expect(rendered.container.textContent).toBe(labels[0])
      rendered.unmount()
    }
    expect(chat.children).toBe(children)
    expect(chat.inject).toBe(inject)
    expect(chat.locale).toBe('chat')
    expect(unrelated.component).toBe(originalUnrelated)
    const replacement = { component: () => null, options: { key: 'context' } }
    const originalReplacement = replacement.component
    entries.set('conversation.chat.node', [replacement])
    listeners.get('conversation.chat.node')?.()
    expect(replacement.component).not.toBe(originalReplacement)
    dispose()
    expect(chat.component).toBe(originalChat)
    expect(trajectory.component).toBe(originalTrajectory)
    expect(replacement.component).toBe(originalReplacement)
    expect(listeners.size).toBe(0)
    expect(node.data.content.map(block => block.toolName)).toEqual(names)
  })
})
