import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { readCompanyBootstrap } from './bootstrap.js'
import { CompanyHost } from './company-host.js'
import { CompanyPersistence } from './persistence.js'
import { registerCompanyRoutes } from './routes.js'
import { AccountBroker, type P7AccountStore } from './account-broker.js'
import { installPersonalCredentialOverlay } from './personal-credential-overlay.js'
import { DEFAULT_P7_PUBLIC_ORIGIN } from './defaults.js'

interface P7AccountBrowser { open(url: string): Promise<void> | void }

declare module '@deepseek-ai/cordis' {
  interface Context { p7Account: AccountBroker; p7AccountBrowser?: P7AccountBrowser; p7AccountStore?: P7AccountStore }
}

export const name = 'p7-company-models'
export const inject = ['loader', 'webServer', 'settings', 'credentials', 'profileContext', 'llm', 'agentDefaultModel']
export const Config = Schema.object({ bootstrapFile: Schema.string().default(''), requirePersonalLogin: Schema.boolean().default(false) })

/** Compose beside the official adapters without modifying the upstream runtime. */
export function apply(ctx: Context, config: { bootstrapFile?: string; requirePersonalLogin?: boolean } = {}): void {
  let host: CompanyHost | undefined
  const accountStore = ctx.get('p7AccountStore')
  const requirePersonalLogin = config.requirePersonalLogin === true
  const account = new AccountBroker({ origin: () => host?.currentOrigin() ?? (requirePersonalLogin ? DEFAULT_P7_PUBLIC_ORIGIN : null), requirePersonalLogin, deviceFingerprint: () => host?.currentDeviceId() ?? '', clientVersion: accountStore?.clientVersion ?? '2.0.18-beta.15', profileId: ctx.profileContext.dir, ...(accountStore ? { store: accountStore } : {}) })
  host = new CompanyHost({
    profileId: ctx.profileContext.dir,
    requirePersonalLogin,
    bootstrap: () => readCompanyBootstrap(config.bootstrapFile ?? ''),
    personalMode: () => account.usesPersonalToken(),
    resolvePersonalAccessToken: () => account.getValidAccessToken(),
    restorePersonalSession: () => account.restore(),
    onPersonalModeLoaded: value => account.setPersonalMode(value),
    persistence: new CompanyPersistence(join(ctx.profileContext.dir, '.p7-company-models.json')),
    settings: ctx.settings,
    modelNamespace: () => {
      const namespaces = new Set(ctx.llm.listConfigurableProviders().filter(entry => entry.settingsPath[0] === 'providers').map(entry => entry.settingsNs))
      if (namespaces.size !== 1) throw new Error('The standard model adapter must have one unambiguous settings entry.')
      return [...namespaces][0]!
    },
    credentials: {
      read: async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
      set: (ref, key) => ctx.credentials.set(credentialRef(ref), key),
      unset: ref => ctx.credentials.unset(credentialRef(ref)),
    },
    readDefault: () => ctx.agentDefaultModel.currentSelection(),
    saveDefault: (provider, model, reasoningEffort) => ctx.agentDefaultModel.saveSelection({
      provider, model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
    }),
  })
  const companyHost = host
  ctx.provide('p7Account', account)
  const browser = ctx.get('p7AccountBrowser')
  account.setBrowserLauncher(browser ? url => browser.open(url) : undefined)
  const removeCredentialOverlay = installPersonalCredentialOverlay(ctx.credentials, credentialRef(companyHost.credentialRef), account)
  // Do not let restore notifications race host initialization; normal login
  // and logout still synchronize immediately after the initial catalog pass.
  let initialized: Promise<void>
  ctx.effect(() => account.subscribe(() => { void initialized.then(() => companyHost.personalSessionChanged()) }), 'p7-company-models: personal session catalog')
  let disposed = false
  ctx.effect(() => () => { disposed = true; removeCredentialOverlay(); return Promise.all([companyHost.dispose(), account.dispose()]).then(() => {}) }, 'p7-company-models: lifecycle')
  // Applying a fetched catalog writes volatile Profile settings. Their editor
  // must validate against a settled Loader, so startup sync cannot hold this
  // plugin's own activation open while waiting for that write.
  initialized = ctx.root.loader.await().then(async () => { if (!disposed) await companyHost.initialize() }).catch(() => {
    ctx.logger.warn('P7 startup synchronization could not complete. Reconnect from company model settings.')
  })
  ctx.effect(() => registerCompanyRoutes(ctx.webServer, {
    status: () => companyHost.status(),
    connect: async (origin, key) => { await initialized; await companyHost.connect(origin, key) },
    sync: async () => { await initialized; await companyHost.sync() },
    disconnect: async () => { await initialized; await companyHost.disconnect() },
  }, account), 'p7-company-models: local settings')
}
export { CompanyHost } from './company-host.js'
export { AccountBroker, getAccountBroker } from './account-broker.js'
export { installPersonalCredentialOverlay } from './personal-credential-overlay.js'
export type { P7AccountProfile, P7AccountStatus, P7Usage, P7UsageTotals } from './account-broker.js'
