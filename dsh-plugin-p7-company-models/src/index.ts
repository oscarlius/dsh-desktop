import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { CompanyHost } from './company-host.js'
import { CompanyPersistence } from './persistence.js'
import { registerCompanyRoutes } from './routes.js'

export const name = 'p7-company-models'
export const inject = ['webServer', 'settings', 'credentials', 'profileContext', 'llm', 'agentDefaultModel']

/** Compose beside the official adapters without modifying the upstream runtime. */
export async function apply(ctx: Context): Promise<void> {
  const host = new CompanyHost({
    profileId: ctx.profileContext.dir,
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
  ctx.effect(() => () => host.dispose(), 'p7-company-models: lifecycle')
  await host.initialize()
  ctx.effect(() => registerCompanyRoutes(ctx.webServer, host), 'p7-company-models: local settings')
}
export { CompanyHost } from './company-host.js'
