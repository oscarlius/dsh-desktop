import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CompanySettingsSection } from './CompanySettingsSection.js'
import { createCompanyModelsApi } from './api.js'
import { installCompanySettingsStyles } from './company-settings-styles.js'
import { en, zh, type CompanySettingsLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'p7-company-models': CompanySettingsLocaleKey }
}

export const inject = ['slots', 'locale']
export const NS = 'p7-company-models'

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'p7-company-models: dictionaries')
  ctx.effect(() => installCompanySettingsStyles(), 'p7-company-models: settings styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'p7-company-models', order: 60, label: () => t('nav'), locale: NS,
  }, CompanySettingsSection))
}

export { CompanySettingsSection }
export { createCompanyModelsApi }
export type { CompanyModelsApi } from './api.js'
