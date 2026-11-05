import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from 'dsh-plugin-p7-company-models'
import type {} from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountBroker } from 'dsh-plugin-p7-company-models'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { p7CredentialRef, P7ConnectionResolver, P7_PERSISTENCE_FILE } from 'dsh-plugin-p7-web-search'
import { P7McpClient, P7McpError } from './client.js'
import { ActivationStore } from './activation-store.js'
import { resolveConfig } from './config.js'
import type { Config as PluginConfig, ResolvedConfig } from './config.js'
import { installLazyRuntime } from './lazy-runtime.js'
import type { LazyRuntime } from './lazy-runtime.js'

export { P7McpClient, P7McpError } from './client.js'
export { Config } from './config.js'
export const name = 'p7-managed-mcp'
export const inject = ['p7Account', 'tools', 'credentials', 'profileContext']

export type PublicMcpToolStatus = {
  phase: 'syncing' | 'registered' | 'unavailable'
  tools: { name: string }[]
  mode?: 'eager' | 'on-demand'
  authorizedToolCount?: number
  agents?: { agentId: string; loadedToolCount: number; schemaBytes: number; tools: { name: string }[]; error?: string }[]
}
const TOOL_STATUS_REGISTRY = Symbol.for('dsh.p7.mcp-tool-status.registry')
function toolStatusRegistry(): Map<string, PublicMcpToolStatus> {
  const host = globalThis as typeof globalThis & { [TOOL_STATUS_REGISTRY]?: Map<string, PublicMcpToolStatus> }
  return host[TOOL_STATUS_REGISTRY] ??= new Map()
}
function publishToolStatus(profileId: string, phase: PublicMcpToolStatus['phase'], names: readonly string[] = [], extra: Partial<PublicMcpToolStatus> = {}): void {
  toolStatusRegistry().set(profileId, { ...extra, phase, tools: names.map(name => ({ name })) })
}
function clearToolStatus(profileId: string): void { toolStatusRegistry().delete(profileId) }

// Peer-isolated runtime packages can expose distinct Cordis declaration identities.
// Declare the capabilities this plugin consumes against its own Context as well.
declare module '@deepseek-ai/cordis' {
  interface Context { p7Account: AccountBroker; credentials: CredentialProvider }
  interface Events { 'credentials/reference-updated'(ref: CredentialRef): void }
}

export function publicToolName(wireName: string): string {
  const full = 'mcp__p7__' + wireName
  return full.length <= 64 ? full : full.slice(0, 51) + '_' + createHash('sha256').update(wireName).digest('hex').slice(0, 12)
}

/** Global Host tools inherit into eligible Agent scopes; existing preset filters remain authoritative. */
export function apply(ctx: Context, input: PluginConfig = {}): void {
  const config = resolveConfig(input)
  if (config.mode === 'on-demand') {
    // AgentRegistry can mount after the P7 account service. Wait through the
    // public injection lifecycle instead of failing or publishing eager tools.
    publishToolStatus(ctx.profileContext.dir, 'syncing', [], { mode: config.mode, authorizedToolCount: 0 })
    ctx.inject(['agents', 'systemPrompt'], inner => { mount(inner, config) })
    ctx.effect(() => () => { clearToolStatus(ctx.profileContext.dir) }, 'p7-mcp pending lifecycle')
    return
  }
  mount(ctx, config)
}

function mount(ctx: Context, config: ResolvedConfig): void {
  const account = ctx.p7Account
  if (!account) throw new Error('P7 account service is required for company MCP')
  const ref = credentialRef(p7CredentialRef(ctx.profileContext.dir))
  const resolver = new P7ConnectionResolver({ profileId: ctx.profileContext.dir, credentialRef: ref, credentials: ctx.credentials,
    persistenceFile: join(ctx.profileContext.dir, P7_PERSISTENCE_FILE), ambientApiKey: () => undefined,
    requestTimeoutMs: 125_000, personalAccessToken: () => account.getValidAccessToken(),
    usesPersonalToken: () => account.usesPersonalToken() })
  const client = new P7McpClient(() => resolver.resolve())
  let generation = 0; let disposed = false; let fingerprint = ''
  let connectionScope = new AbortController()
  let phase: PublicMcpToolStatus['phase'] = 'syncing'
  let advertisedNames: string[] = []
  const store = config.mode === 'on-demand' ? new ActivationStore({ nameMapper: publicToolName, ...config }) : undefined
  let lazy: LazyRuntime | undefined
  const publish = (): void => {
    const agents = store ? ctx.agents.list().map(agent => {
      const visible = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
      const active = store.active(agent, tool => visible.has(tool.publicName))
      const error = lazy?.errorFor(agent)
      return { agentId: String(agent.id), loadedToolCount: active.length, schemaBytes: active.reduce((sum, tool) => sum + tool.schemaBytes, 0), tools: active.map(tool => ({ name: tool.publicName })), ...(error ? { error } : {}) }
    }) : undefined
    publishToolStatus(ctx.profileContext.dir, phase, advertisedNames, {
      mode: config.mode, authorizedToolCount: advertisedNames.length, ...(agents ? { agents } : {}),
    })
  }
  lazy = store ? installLazyRuntime(ctx, store, config, publish) : undefined
  const owned: Array<() => void> = []
  const clear = (): void => { for (const dispose of owned.splice(0)) dispose(); fingerprint = '' }
  const invalidate = (identityChanged = false): void => {
    if (identityChanged) {
      connectionScope.abort()
      connectionScope = new AbortController()
    }
    store?.invalidateCatalog()
    advertisedNames = []
    clear()
  }
  publish()
  const sync = async (): Promise<void> => {
    const current = ++generation
    try {
      const tools = (await client.list()).toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      if (disposed || generation !== current) return
      const next = JSON.stringify(tools)
      if (next === fingerprint) return
      const definitions = tools.map(tool => createMcpToolDefinition(ctx, {
        name: publicToolName(tool.name), rawName: tool.name, description: tool.description,
        inputSchema: tool.inputSchema,
        call: async (args, execution) => {
          const identitySignal = connectionScope.signal
          const signal = execution.signal ? AbortSignal.any([execution.signal, identitySignal]) : identitySignal
          try { return await client.call(tool.name, args, signal) }
          catch (error) {
            // A supplier failure does not change the advertised tools. Refresh
            // authorization only when the gateway actually rejects access.
            if (error instanceof P7McpError) {
              if (error.status === 401 || error.status === 403) void sync()
              throw error
            }
            if (execution.signal?.aborted) throw error
            throw new Error('公司工具请求未完成，请检查网络或服务状态，避免连续重试。')
          }
        },
      }))
      store?.publishCatalog(tools)
      clear()
      try {
        for (const definition of definitions) owned.push(ctx.tools.register(definition, lazy?.registrationOptions(definition.name)))
        fingerprint = next
        advertisedNames = tools.map(tool => publicToolName(tool.name))
        phase = 'registered'
        lazy?.refresh()
        publish()
      }
      catch { invalidate(); throw new Error('Company tool namespace conflict') }
    } catch {
      if (!disposed && generation === current) { invalidate(); phase = 'unavailable'; publish() }
    }
  }
  const identityOf = (status: ReturnType<AccountBroker['status']> | undefined): string | undefined => {
    if (!status) return undefined
    const profile = status.profile
    return JSON.stringify({
      phase: status.phase, personal: account.usesPersonalToken(),
      origin: typeof account.connection === 'function' ? account.connection().origin : null,
      profile: profile ? { userId: profile.userId, organizationId: profile.organizationId,
        deviceId: profile.deviceId, sessionId: profile.sessionId, role: profile.role, scopes: [...profile.scopes].sort() } : null,
    })
  }
  let accountIdentity = identityOf(typeof account.status === 'function' ? account.status() : undefined)
  const unsubscribe = account.subscribe(status => {
    const identity = identityOf(status)
    // A normal token renewal keeps the same principal/session. Cancelling its
    // resolver here would make the first call after every renewal fail.
    if (identity !== undefined && identity === accountIdentity) return
    accountIdentity = identity
    generation++; invalidate(true); phase = 'syncing'; publish(); void sync()
  })
  ctx.on('credentials/reference-updated', updated => { if (updated === ref) { generation++; invalidate(true); phase = 'syncing'; publish(); void sync() } })
  const timer = setInterval(() => { void sync() }, 20_000)
  timer.unref()
  void sync()
  ctx.effect(() => () => {
    disposed = true; generation++; store?.close(); connectionScope.abort()
    clearInterval(timer); unsubscribe(); clear(); lazy?.dispose(); clearToolStatus(ctx.profileContext.dir)
  }, 'p7-mcp lifecycle')
}
