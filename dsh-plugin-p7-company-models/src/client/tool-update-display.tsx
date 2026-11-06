import { createElement, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanySettingsLocaleKey } from './locales.js'
import { toolDisplayName } from './tool-capabilities.js'

type CompanyTranslate = (key: CompanySettingsLocaleKey) => string

/** Localize only tool-update labels; recorded context and invocation IDs stay intact. */
export function withCompanyToolNames(t: Translate, companyT: CompanyTranslate): Translate {
  return (key, params) => {
    if (key === 'tool.displayName' && typeof params?.name === 'string') return toolDisplayName(params.name, companyT)
    const field = /^(message|layout)\.tools(Added|Removed)$/.test(key) ? 'names'
      : /^(message|layout)\.tool(Added|Removed)$/.test(key) ? 'name' : undefined
    if (field === undefined || typeof params?.[field] !== 'string') return t(key, params)
    const value = params[field].replace(/\bmcp__p7__[A-Za-z0-9_-]+\b/g, name => toolDisplayName(name, companyT))
    return t(key, { ...params, [field]: value })
  }
}

type DisplayProps = { t: Translate }
type DisplayEntry = { component: ComponentType<DisplayProps>; options: { key?: string; id?: string } }

function decorate(component: ComponentType<DisplayProps>, companyT: CompanyTranslate): ComponentType<DisplayProps> {
  const translations = new WeakMap<Translate, Translate>()
  return function CompanyToolUpdateDisplay(props) {
    let t = translations.get(props.t)
    if (t === undefined) {
      t = withCompanyToolNames(props.t, companyT)
      translations.set(props.t, t)
    }
    return createElement(component, { ...props, t })
  }
}

/** Use the same reversible entry decoration as the existing historical display adapter. */
export function installCompanyToolUpdateDisplay(ctx: Context): () => void {
  const companyT = ctx.locale.bind('p7-company-models')
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
      const wrapper = decorate(component, companyT)
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
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
