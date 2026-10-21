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
import { P7McpClient } from './client.js'

export { P7McpClient, P7McpError } from './client.js'
export const name = 'p7-managed-mcp'
export const inject = ['p7Account', 'tools', 'credentials', 'profileContext']

type PublicMcpToolStatus = { phase: 'syncing' | 'registered' | 'unavailable'; tools: { name: string }[] }
const TOOL_STATUS_REGISTRY = Symbol.for('dsh.p7.mcp-tool-status.registry')
function toolStatusRegistry(): Map<string, PublicMcpToolStatus> {
  const host = globalThis as typeof globalThis & { [TOOL_STATUS_REGISTRY]?: Map<string, PublicMcpToolStatus> }
  return host[TOOL_STATUS_REGISTRY] ??= new Map()
}
function publishToolStatus(profileId: string, phase: PublicMcpToolStatus['phase'], names: readonly string[] = []): void {
  toolStatusRegistry().set(profileId, { phase, tools: names.map(name => ({ name })) })
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
export function apply(ctx: Context): void {
  const account = ctx.p7Account
  if (!account) throw new Error('P7 account service is required for company MCP')
  const ref = credentialRef(p7CredentialRef(ctx.profileContext.dir))
  const resolver = new P7ConnectionResolver({ profileId: ctx.profileContext.dir, credentialRef: ref, credentials: ctx.credentials,
    persistenceFile: join(ctx.profileContext.dir, P7_PERSISTENCE_FILE), ambientApiKey: () => undefined,
    requestTimeoutMs: 125_000, personalAccessToken: () => account.getValidAccessToken(),
    usesPersonalToken: () => account.usesPersonalToken() })
  const client = new P7McpClient(() => resolver.resolve())
  let generation = 0; let disposed = false; let fingerprint = ''
  const owned: Array<() => void> = []
  const clear = (): void => { for (const dispose of owned.splice(0)) dispose(); fingerprint = '' }
  publishToolStatus(ctx.profileContext.dir, 'syncing')
  const sync = async (): Promise<void> => {
    const current = ++generation
    try {
      const tools = await client.list()
      if (disposed || generation !== current) return
      const next = JSON.stringify(tools)
      if (next === fingerprint) return
      const definitions = tools.map(tool => createMcpToolDefinition(ctx, {
        name: publicToolName(tool.name), rawName: tool.name, description: tool.description,
        inputSchema: tool.inputSchema,
        call: async (args, execution) => {
          try { return await client.call(tool.name, args, execution.signal) }
          catch { void sync(); throw new Error('Company tool failed or permission changed. Retry only after checking its status.') }
        },
      }))
      clear()
      try {
        for (const definition of definitions) owned.push(ctx.tools.register(definition))
        fingerprint = next
        publishToolStatus(ctx.profileContext.dir, 'registered', tools.map(tool => publicToolName(tool.name)))
      }
      catch { clear(); throw new Error('Company tool namespace conflict') }
    } catch {
      if (!disposed && generation === current) { clear(); publishToolStatus(ctx.profileContext.dir, 'unavailable') }
    }
  }
  const unsubscribe = account.subscribe(() => { generation++; clear(); publishToolStatus(ctx.profileContext.dir, 'syncing'); void sync() })
  ctx.on('credentials/reference-updated', updated => { if (updated === ref) { generation++; clear(); publishToolStatus(ctx.profileContext.dir, 'syncing'); void sync() } })
  const timer = setInterval(() => { void sync() }, 20_000)
  timer.unref()
  void sync()
  ctx.effect(() => () => { disposed = true; generation++; clearInterval(timer); unsubscribe(); clear(); clearToolStatus(ctx.profileContext.dir) }, 'p7-mcp lifecycle')
}
