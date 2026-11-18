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
import { CompanyHost, type ManagedModelSelectionResolver } from './company-host.js'
import { CompanyPersistence } from './persistence.js'
import { registerCompanyRoutes, type CompanyWebRouteAdmission } from './routes.js'
import { AccountBroker, type P7AccountService, type P7AccountStore } from './account-broker.js'
import { installPersonalCredentialOverlay } from './personal-credential-overlay.js'
import { DEFAULT_P7_PUBLIC_ORIGIN } from './defaults.js'
import { installInlineThinkingNormalizer } from './inline-thinking.js'
import { installToolProgressGuard, type ToolProgressGuardConfig } from './tool-progress-guard.js'
import { installAgentContractGuard } from './agent-contract-guard.js'
import { registerPersonalMemoryRoutes } from './personal-memory-routes.js'
import { CompanyMemoryRuntime, type CompanyMemoryWorkspace } from './personal-memory-runtime.js'

interface P7AccountBrowser { open(url: string): Promise<void> | void }
export interface P7AccountFactoryOptions { origin(): string | null; profileId: string; requirePersonalLogin: boolean; deviceFingerprint(): string; clientVersion: string }
export interface P7AccountFactory { create(options: P7AccountFactoryOptions): P7AccountService }

declare module '@deepseek-ai/cordis' {
  interface Context { p7Account: P7AccountService; p7AccountBrowser?: P7AccountBrowser; p7AccountStore?: P7AccountStore; p7AccountFactory?: P7AccountFactory; p7CompanyRouteAdmission?: CompanyWebRouteAdmission; p7CompanyModels?: ManagedModelSelectionResolver }
}

export const name = 'p7-company-models'
export const inject = ['loader', 'webServer', 'settings', 'credentials', 'profileContext', 'llm', 'agentDefaultModel']
export const Config: Schema = Schema.object({
  bootstrapFile: Schema.string().default(''),
  requirePersonalLogin: Schema.boolean().default(false),
  agentContractGuard: Schema.boolean().default(true),
  toolProgressGuard: Schema.object({
    patternWindow: Schema.number().default(8),
    maxDistinctPatterns: Schema.number().default(2),
    repeatedPatternThreshold: Schema.number().default(8),
    repeatedErrorThreshold: Schema.number().default(4),
    ignoreToolNamePatterns: Schema.array(Schema.string()).default(['*poll*', '*watch*', '*stream*', '*subscribe*']),
  }).default({}),
})

/** Compose beside the official adapters without modifying the upstream runtime. */
export function apply(ctx: Context, config: { bootstrapFile?: string; requirePersonalLogin?: boolean; toolProgressGuard?: ToolProgressGuardConfig; agentContractGuard?: boolean } = {}): void {
  installInlineThinkingNormalizer(ctx)
  installToolProgressGuard(ctx, config.toolProgressGuard)
  if (config.agentContractGuard !== false) installAgentContractGuard(ctx)
  let host: CompanyHost | undefined
  const accountStore = ctx.get('p7AccountStore')
  const requirePersonalLogin = config.requirePersonalLogin === true
  const accountOptions: P7AccountFactoryOptions = { origin: () => host?.currentOrigin() ?? (requirePersonalLogin ? DEFAULT_P7_PUBLIC_ORIGIN : null), requirePersonalLogin, deviceFingerprint: () => host?.currentDeviceId() ?? '', clientVersion: accountStore?.clientVersion ?? '2.0.18-beta.15', profileId: ctx.profileContext.dir }
  const accountFactory = ctx.get('p7AccountFactory')
  const account: P7AccountService = accountFactory?.create(accountOptions) ?? new AccountBroker({ ...accountOptions, ...(accountStore ? { store: accountStore } : {}) })
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
  ctx.provide('p7CompanyModels', companyHost)
  const browser = ctx.get('p7AccountBrowser')
  if (account instanceof AccountBroker) account.setBrowserLauncher(browser ? url => browser.open(url) : undefined)
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
  const routeAdmission = ctx.get('p7CompanyRouteAdmission')
  ctx.effect(() => registerCompanyRoutes(ctx.webServer, {
    status: () => companyHost.status(),
    connect: async (origin, key) => { await initialized; await companyHost.connect(origin, key) },
    sync: async () => { await initialized; await companyHost.sync() },
    disconnect: async () => { await initialized; await companyHost.disconnect() },
  }, account, routeAdmission), 'p7-company-models: local settings')
  let memory: CompanyMemoryRuntime | undefined
  ctx.effect(() => registerPersonalMemoryRoutes(ctx.webServer, account, () => memory?.snapshot(), routeAdmission), 'p7-company-models: personal memory routes')
  void initialized.then(() => {
    if (disposed) return
    const connection = ctx.get('connection') as { authenticatedUrl(origin: string): string } | undefined
    const workspaces = ctx.get('workspaceRegistry') as { list(): readonly CompanyMemoryWorkspace[] } | undefined
    if (!connection || !workspaces) return
    try {
      memory = new CompanyMemoryRuntime({ account, profileDirectory: ctx.profileContext.dir,
        origin: () => ctx.webServer.getOrigin(), authenticatedUrl: value => connection.authenticatedUrl(value),
        workspaces: () => workspaces.list(), log: code => ctx.logger.warn(code) })
      memory.start()
    } catch { ctx.logger.warn('memory_sync_checkpoint_unavailable') }
  })
  ctx.effect(() => () => memory?.dispose(), 'p7-company-models: personal memory synchronization')
}
export { CompanyHost } from './company-host.js'
export { AccountBroker, getAccountBroker } from './account-broker.js'
export { installPersonalCredentialOverlay } from './personal-credential-overlay.js'
export type { P7AccountProfile, P7AccountService, P7AccountStatus, P7Usage, P7UsageTotals } from './account-broker.js'
