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

export const name = 'p7-company-models'
export const inject = ['loader', 'webServer', 'settings', 'credentials', 'profileContext', 'llm', 'agentDefaultModel']
export const Config = Schema.object({ bootstrapFile: Schema.string().default('') })

/** Compose beside the official adapters without modifying the upstream runtime. */
export function apply(ctx: Context, config: { bootstrapFile?: string } = {}): void {
  const host = new CompanyHost({
    profileId: ctx.profileContext.dir,
    bootstrap: () => readCompanyBootstrap(config.bootstrapFile ?? ''),
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
  let disposed = false
  ctx.effect(() => () => { disposed = true; return host.dispose() }, 'p7-company-models: lifecycle')
  // Applying a fetched catalog writes volatile Profile settings. Their editor
  // must validate against a settled Loader, so startup sync cannot hold this
  // plugin's own activation open while waiting for that write.
  const initialized = ctx.root.loader.await().then(async () => { if (!disposed) await host.initialize() }).catch(() => {
    ctx.logger.warn('P7 startup synchronization could not complete. Reconnect from company model settings.')
  })
  ctx.effect(() => registerCompanyRoutes(ctx.webServer, {
    status: () => host.status(),
    connect: async (origin, key) => { await initialized; await host.connect(origin, key) },
    sync: async () => { await initialized; await host.sync() },
    disconnect: async () => { await initialized; await host.disconnect() },
  }), 'p7-company-models: local settings')
}
export { CompanyHost } from './company-host.js'
