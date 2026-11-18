import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

interface WebVersionInfo {
  webVersion: string
  build: string | null
  harnessVersion: string
}

const NS = 'dsh-web-version'
const zh = { title: '版本信息', web: 'Web 版本', build: '构建号', harness: 'Harness 版本', unknown: '未标记' } as const
const en = { title: 'Version information', web: 'Web version', build: 'Build', harness: 'Harness version', unknown: 'Unspecified' } as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'dsh-web-version': keyof typeof zh }
}

export function registerWebVersionInfo(ctx: Context): void {
  const info = (globalThis as typeof globalThis & { dshWebVersionInfo?: WebVersionInfo }).dshWebVersionInfo
  if (!info) return
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-version: dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'version-management', order: 101, label: () => t('title'), locale: NS,
    inject: () => ({ info }),
  }, VersionInfoSection))
}

function VersionInfoSection({ info, t }: PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & { info: WebVersionInfo }) {
  return <section className="dshP7CompanySettings" aria-labelledby="dsh-web-version-title">
    <header className="dshP7CompanySettingsHeader"><h2 id="dsh-web-version-title">{t('title')}</h2></header>
    <dl className="dshP7CompanySettingsCard dshP7CompanySettingsDefinitionGrid">
      <div><dt>{t('web')}</dt><dd>{info.webVersion}</dd></div>
      <div><dt>{t('build')}</dt><dd>{info.build ?? t('unknown')}</dd></div>
      <div><dt>{t('harness')}</dt><dd>{info.harnessVersion}</dd></div>
    </dl>
  </section>
}
