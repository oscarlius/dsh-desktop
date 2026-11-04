import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRegistrationOptions } from '@deepseek-ai/dsh-tools'
import { ActivationStore } from './activation-store.js'
import type { CatalogEntry } from './activation-store.js'
import type { ResolvedConfig } from './config.js'

export const SEARCH_TOOL_NAME = 'p7_mcp_search'
export const LOAD_TOOL_NAME = 'p7_mcp_load'

export interface LazyRuntime {
  registrationOptions(name: string): ToolRegistrationOptions
  refresh(): void
  errorFor(agent: Agent): string | undefined
  dispose(): void
}

function argumentsObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('P7_MCP_INVALID_ARGUMENTS')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error('P7_MCP_INVALID_ARGUMENTS')
  return result
}

/** Only public policy queries are used; no lazy restriction is temporarily lifted. */
export function installLazyRuntime(
  ctx: Context,
  store: ActivationStore,
  config: ResolvedConfig,
  changed: () => void = () => {},
): LazyRuntime {
  if (!ctx.get('agents') || typeof ctx.tools.resolve !== 'function') throw new Error('P7_MCP_ON_DEMAND_REQUIRES_RC1_AGENT_SERVICES')
  let closed = false
  let registryVersion = 0
  const disposedAgents = new WeakSet<Agent>()
  const scopeErrors = new WeakMap<Agent, string>()
  const bootstrapped = new WeakMap<Agent, { epoch: number; registryVersion: number }>()
  const isLive = (agent: Agent): boolean => !disposedAgents.has(agent) && ctx.agents.list().some(current => current === agent)
  const visible = (agent: Agent) => {
    const names = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
    return (entry: CatalogEntry): boolean => names.has(entry.publicName)
  }
  const active = (agent: Agent): readonly CatalogEntry[] => store.active(agent, visible(agent))

  const bootstrap = (agent: Agent): boolean => {
    if (closed || !store.available) return false
    const previous = bootstrapped.get(agent)
    if (previous?.epoch === store.epoch && previous.registryVersion === registryVersion) return false
    let stateChanged = false
    // Explicit business-only filters must still work without adding discovery
    // capabilities their policy did not permit.
    if (!ctx.tools.get(SEARCH_TOOL_NAME, agent) && !ctx.tools.get(LOAD_TOOL_NAME, agent)) {
      const permitted = store.eligible(agent, visible(agent))
      if (permitted.length) {
        const current = new Set(active(agent).map(tool => tool.toolId))
        if (permitted.length !== current.size || permitted.some(tool => !current.has(tool.toolId))) {
          const result = store.load(agent, permitted.map(tool => tool.toolId), visible(agent))
          if (!result.ok) throw new Error(`P7_MCP_FIXED_PRESET_${result.reason.toUpperCase().replaceAll('-', '_')}`)
          stateChanged = true
        }
      }
    }
    bootstrapped.set(agent, { epoch: store.epoch, registryVersion })
    return scopeErrors.delete(agent) || stateChanged
  }

  const initializeAgent = (agent: Agent, failPreparation: boolean): void => {
    try { if (bootstrap(agent)) changed() } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (!/^P7_MCP_FIXED_PRESET_[A-Z_]+$/.test(message)) throw error
      const prior = scopeErrors.get(agent)
      scopeErrors.set(agent, message)
      if (prior !== message) changed()
      if (failPreparation) throw error
    }
  }

  const requireAgent = (agent: Agent | undefined): Agent => {
    if (closed || !agent || !isLive(agent)) throw new Error('P7_MCP_AGENT_SCOPE_REQUIRED')
    initializeAgent(agent, true)
    return agent
  }

  const resultFor = (agent: Agent, tools: readonly { toolId: string; description: string }[]) => ({
    ok: true,
    status: 'loaded',
    tools: tools.map(tool => ({ toolId: tool.toolId, description: tool.description.slice(0, 160) })),
    loadedToolCount: active(agent).length,
    schemaBytes: active(agent).reduce((sum, tool) => sum + tool.schemaBytes, 0),
  })

  const helpers: ToolDefinition[] = [
    {
      name: SEARCH_TOOL_NAME,
      description: 'Search company MCP tools available to this Agent and activate relevant tools for its next step. This does not execute a business query. Use a focused query; tools are loaded only in this Agent.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 512 }, namespace: { type: 'string', maxLength: 64 }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['query'], additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (input, execution) => {
        const agent = requireAgent(execution.agent)
        const args = argumentsObject(input, ['query', 'namespace', 'limit'])
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 512
          || (args.namespace !== undefined && (typeof args.namespace !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(args.namespace)))
          || (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10))) throw new Error('P7_MCP_INVALID_ARGUMENTS')
        const found = store.search(agent, args.query, args.namespace as string | undefined,
          args.limit as number | undefined ?? Math.min(config.searchLimit, config.maxLoadedTools), visible(agent))
        if (!found.ok) return { ok: false, status: found.reason }
        if (!found.tools.length) return { ok: true, status: 'no-match', tools: [] }
        const loaded = store.load(agent, found.tools.map(tool => tool.toolId), visible(agent))
        if (!loaded.ok) return { ok: false, status: loaded.reason }
        changed()
        return resultFor(agent, found.tools)
      },
    },
    {
      name: LOAD_TOOL_NAME,
      description: 'Activate explicitly known company MCP tool IDs in this Agent. Existing permissions and Agent filters still apply. No business tool executes until a later tool call.',
      parameters: { type: 'object', properties: { toolIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 128 } }, required: ['toolIds'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (input, execution) => {
        const agent = requireAgent(execution.agent)
        const args = argumentsObject(input, ['toolIds'])
        if (!Array.isArray(args.toolIds) || !args.toolIds.length || args.toolIds.length > 128 || args.toolIds.some(id => typeof id !== 'string')) throw new Error('P7_MCP_INVALID_ARGUMENTS')
        const loaded = store.load(agent, args.toolIds as string[], visible(agent))
        if (!loaded.ok) return { ok: false, status: loaded.reason }
        changed()
        return resultFor(agent, loaded.tools)
      },
    },
  ]

  const removeGuard = ctx.tools.guard(execution => {
    if (!store.owns(execution.name)) return undefined
    if (closed || !execution.agent || !isLive(execution.agent)) return 'P7_MCP_AGENT_SCOPE_REQUIRED'
    if (!store.available) return 'P7_MCP_CATALOG_UNAVAILABLE'
    return active(execution.agent).some(tool => tool.publicName === execution.name) ? undefined : 'P7_MCP_TOOL_NOT_LOADED'
  })
  const removers: Array<() => void> = []
  try {
    removers.push(ctx.on('tools/change', () => { registryVersion++ }))
    for (const helper of helpers) removers.push(ctx.tools.register(helper))
    removers.push(ctx.on('agent/created', ({ agent }) => { initializeAgent(agent, false); return undefined }))
    removers.push(ctx.on('agent/disposed', ({ agent }) => {
      disposedAgents.add(agent)
      scopeErrors.delete(agent)
      bootstrapped.delete(agent)
      store.forgetAgent(agent)
      changed()
    }))
    for (const agent of ctx.agents.list()) initializeAgent(agent, true)
  } catch (error) {
    closed = true
    for (const remove of removers.reverse()) remove()
    removeGuard()
    throw error
  }

  return {
    registrationOptions: name => ({
      when: ({ agent }) => {
        if (closed || !store.available || !isLive(agent)) return false
        initializeAgent(agent, true)
        // rc.1 has already applied the current scoped policy before calling
        // `when`. The resulting step snapshot drives native/PTC declarations
        // and execution together; discovery changes admission next step only.
        return store.active(agent, () => true).some(tool => tool.publicName === name)
      },
    }),
    refresh: () => {
      // Known fixed-preset configuration errors belong to the exact Agent;
      // unexpected registry/runtime errors remain visible to the caller.
      for (const agent of ctx.agents.list()) initializeAgent(agent, false)
    },
    errorFor: agent => scopeErrors.get(agent),
    dispose: () => {
      closed = true
      for (const remove of removers.reverse()) remove()
      removeGuard()
    },
  }
}
