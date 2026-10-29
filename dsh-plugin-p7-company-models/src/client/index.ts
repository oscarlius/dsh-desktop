import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CompanySettingsSection } from './CompanySettingsSection.js'
import { CompanyLoginGate } from './CompanyLoginGate.js'
import { createCompanyModelsApi } from './api.js'
import { installCompanySettingsStyles } from './company-settings-styles.js'
import { installLegacyInlineThinkingDisplay } from './legacy-inline-thinking.js'
import { en, zh, type CompanySettingsLocaleKey } from './locales.js'
import { registerCompanyModelPicker } from './CompanyModelPicker.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'p7-company-models': CompanySettingsLocaleKey }
  // The company companion is loaded by shells that provide this standard root slot.
  // Repeat its public contract here so this package remains independently typecheckable.
  interface SlotMap { 'shell.overlay': { kind: 'list'; scope: 'root' } }
}

export const inject = ['slots', 'locale']
export const NS = 'p7-company-models'

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'p7-company-models: dictionaries')
  ctx.effect(() => installCompanySettingsStyles(), 'p7-company-models: settings styles')
  ctx.effect(() => installLegacyInlineThinkingDisplay(ctx), 'p7-company-models: legacy inline thinking display')
  registerCompanyModelPicker(ctx)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'p7-company-models', order: 60, label: () => t('nav'), locale: NS,
  }, CompanySettingsSection))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'p7-company-login-gate', order: 1000, locale: NS,
  }, CompanyLoginGate))
}

export { CompanySettingsSection }
export { CompanyLoginGate }
export { createCompanyModelsApi }
export type { CompanyModelsApi } from './api.js'
