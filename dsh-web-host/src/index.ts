import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from 'dsh-plugin-p7-company-models'
import { createRequire } from 'node:module'
import { createWebAccountFactory, webRouteAdmission, type WebRequestTrust } from './web-account.js'
import { installAgentActivityProbe } from './activity.js'
import { registerControllerActivityRoute } from './controller-route.js'
import { createCoreCookieBroker, registerBootstrapRoute } from './bootstrap-route.js'
import { exchangeLaunchToken } from './core-cookie.js'
import { installTencentMemory } from './tencent-memory.js'
import { installToolObservations } from './tool-observations.js'
import { installEmployeeProfile } from './employee-profile.js'
import { initializeCompanyWorkspace } from './default-workspace.js'

declare module '@deepseek-ai/cordis' { interface Context { p7WebTrustedSession?: WebRequestTrust } }

export const name = 'dsh-web-host'
export const inject = ['p7WebTrustedSession', 'webServer', 'agents', 'connection', 'workspaceRegistry']
export interface WebHostConfig { publicOrigin: string; companyOrigin?: string }

const require = createRequire(import.meta.url)

/** Compose the existing business plugins around controller-owned Web identity. */
export async function apply(ctx: Context, config: WebHostConfig): Promise<void> {
  const publicOrigin = new URL(config.publicOrigin).origin
  if (publicOrigin !== config.publicOrigin || !publicOrigin.startsWith('https://')) throw new Error('Web Host requires one exact HTTPS public origin.')
  const companyOrigin = config.companyOrigin ?? publicOrigin
  if (new URL(companyOrigin).origin !== companyOrigin || !companyOrigin.startsWith('https://')) throw new Error('Web Host requires one exact HTTPS company origin.')
  const trust = ctx.p7WebTrustedSession
  if (!trust) throw new Error('Web Host requires the controller trusted-session binding.')
  // The official connection service owns the process launch token in memory, so
  // cookie renewal never writes that token to disk.
  const connection = (ctx as unknown as { connection?: { authenticatedUrl(baseUrl: string): string } }).connection
  if (!connection) throw new Error('Web Host requires the official connection service.')
  await initializeCompanyWorkspace(ctx.workspaceRegistry)
  const authority = new URL(publicOrigin).host
  const broker = createCoreCookieBroker({ mint: async () => {
    const minted = new URL(connection.authenticatedUrl(`${publicOrigin}/`))
    const token = minted.searchParams.get('token')
    if (!token) throw new Error('official connection service did not issue a launch token')
    return exchangeLaunchToken(new URL(ctx.webServer.getOrigin()), authority, token)
  } })
  ctx.provide('p7AccountFactory', createWebAccountFactory({ publicOrigin: companyOrigin }))
  ctx.provide('p7CompanyRouteAdmission', webRouteAdmission(publicOrigin, trust))
  installEmployeeProfile(ctx, companyOrigin)
  if (process.env.P7_DSH_TENCENT_MEMORY === '1') installTencentMemory(ctx, companyOrigin)
  if (process.env.P7_DSH_TOOL_OBSERVATIONS === '1') installToolObservations(ctx, companyOrigin)
  const versionInfo = {
    webVersion: require('../package.json').version as string,
    build: process.env.DSH_WEB_BUILD_ID?.trim() || null,
    harnessVersion: require('@deepseek-ai/dsh/package.json').version as string,
  }
  ctx.on('webserver/index-inject', table => {
    table.unshift({ kind: 'global', name: 'dshWebVersionInfo', value: versionInfo })
    // The browser plugin reads localStorage from its factory. Seed first-run
    // preferences ahead of that factory and preserve the user's saved choices.
    const defaults = JSON.stringify({ mode: 'fold', windowHeight: 180, sparks: false, forgeSparks: false, settleToPrompt: false, keepUserQuestions: true })
    table.unshift({ kind: 'script', placement: 'head', text: `try{const k="dsh-streamfold";if(localStorage.getItem(k)===null)localStorage.setItem(k,${JSON.stringify(defaults)})}catch{}` })
  })
  const activity = installAgentActivityProbe(ctx)
  ctx.effect(() => registerControllerActivityRoute(ctx.webServer, activity), 'dsh-web-host: controller activity')
  ctx.effect(() => registerBootstrapRoute(ctx.webServer, broker), 'dsh-web-host: controller bootstrap')
}
export { WebAccountBroker, readPrivateWebAccount } from './web-account.js'
export { CONTROLLER_ACTIVITY_PATH, CONTROLLER_READY_PATH } from './controller-route.js'
export { BOOTSTRAP_PATH } from './bootstrap-route.js'
export { launchOfficialWeb } from './launcher.js'
export type { WebActivityProbe, WebActivitySnapshot } from './activity.js'
