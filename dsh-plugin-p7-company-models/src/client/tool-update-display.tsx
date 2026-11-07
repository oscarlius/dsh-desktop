import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanySettingsLocaleKey } from './locales.js'
import { createCompanyModelsApi } from './api.js'
import { toolDisplayName } from './tool-capabilities.js'

type CompanyTranslate = (key: CompanySettingsLocaleKey) => string

/** Localize only tool-update labels; recorded context and invocation IDs stay intact. */
export function withCompanyToolNames(t: Translate, companyT: CompanyTranslate, titles: ReadonlyMap<string, string> = new Map()): Translate {
  return (key, params) => {
    const displayName = (name: string) => toolDisplayName(name, companyT, titles.get(name))
    if (key === 'tool.displayName' && typeof params?.name === 'string') return displayName(params.name)
    const field = /^(message|layout)\.tools(Added|Removed)$/.test(key) ? 'names'
      : /^(message|layout)\.tool(Added|Removed)$/.test(key) ? 'name' : undefined
    if (field === undefined || typeof params?.[field] !== 'string') return t(key, params)
    const value = params[field].replace(/\bmcp__p7__[A-Za-z0-9_-]+\b/g, displayName)
    return t(key, { ...params, [field]: value })
  }
}

type DisplayProps = { t: Translate }
type DisplayEntry = { component: ComponentType<DisplayProps>; options: { key?: string; id?: string } }
type TitleStore = { titles: Map<string, string>; subscribe(listener: () => void): () => void; snapshot(): number; replace(tools: ReadonlyArray<{ name: string; title?: string }>): void }

export function createCompanyToolTitleStore(): TitleStore {
  const titles = new Map<string, string>(); const listeners = new Set<() => void>(); let version = 0
  const valid = (name: string, title: string) => /^mcp__p7__[A-Za-z0-9_-]+$/.test(name) && title.length <= 160 && title.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(title)
  return { titles, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, snapshot: () => version,
    replace(tools) {
      const next = new Map<string, string>()
      for (const tool of tools) if (tool.title && valid(tool.name, tool.title)) next.set(tool.name, tool.title.trim())
      if (next.size === titles.size && [...next].every(([name, title]) => titles.get(name) === title)) return
      titles.clear(); for (const [name, title] of next) titles.set(name, title)
      version++; for (const listener of listeners) listener()
    },
  }
}

function decorate(component: ComponentType<DisplayProps>, companyT: CompanyTranslate, store: TitleStore): ComponentType<DisplayProps> {
  const translations = new WeakMap<Translate, Translate>()
  return function CompanyToolUpdateDisplay(props) {
    useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
    let t = translations.get(props.t)
    if (t === undefined) {
      t = withCompanyToolNames(props.t, companyT, store.titles)
      translations.set(props.t, t)
    }
    return createElement(component, { ...props, t })
  }
}

/** Use the same reversible entry decoration as the existing historical display adapter. */
export function installCompanyToolUpdateDisplay(ctx: Context): () => void {
  const companyT = ctx.locale.bind('p7-company-models')
  const titles = createCompanyToolTitleStore()
  let disposed = false
  let refreshing = false
  let controller: AbortController | undefined
  const refresh = async (): Promise<void> => {
    if (disposed || refreshing) return
    refreshing = true; controller = new AbortController()
    try {
      const status = await createCompanyModelsApi().status(controller.signal)
      if (disposed) return
      titles.replace(status.tools.tools)
    } catch {
      if (!disposed) titles.replace([])
    } finally { refreshing = false; controller = undefined }
  }
  void refresh()
  const timer = setInterval(() => { void refresh() }, 5_000)
  const targets = [
    { slot: 'conversation.chat.node', matches: (entry: DisplayEntry) => entry.options.key === 'context' },
    { slot: 'conversation.view', matches: (entry: DisplayEntry) => entry.options.id === 'trajectory' },
  ]
  const disposers = targets.map(({ slot, matches }) => ctx.slots.inject(slot as never, () => {
    // Keep the original slot's child ownership, injected services, locale and priority.
    const decorated = new Map<DisplayEntry, { component: ComponentType<DisplayProps>; wrapper: ComponentType<DisplayProps> }>()
    const install = () => {
      const entry = (ctx.slots.entriesOfSlot(slot as never) as DisplayEntry[]).find(matches)
      if (entry === undefined || decorated.has(entry)) return
      const component = entry.component
      const wrapper = decorate(component, companyT, titles)
      entry.component = wrapper
      decorated.set(entry, { component, wrapper })
    }
    const unsubscribe = ctx.slots.subscribe(slot as never, install)
    install()
    return () => {
      unsubscribe()
      for (const [entry, original] of decorated) if (entry.component === original.wrapper) entry.component = original.component
    }
  }))
  return () => { disposed = true; controller?.abort(); clearInterval(timer); titles.replace([]); for (const dispose of disposers.reverse()) dispose() }
}
