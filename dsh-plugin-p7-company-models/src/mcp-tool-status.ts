/**
 * Secret-free MCP registration state shared by the Host plugins for one Profile.
 * The renderer receives only public tool names and lifecycle state; credentials,
 * endpoint details, schemas, and tool-call arguments stay in the Host.
 */
export interface P7McpToolStatus {
  phase: 'syncing' | 'registered' | 'unavailable'
  tools: { name: string }[]
  mode?: 'eager' | 'on-demand'
  authorizedToolCount?: number
  agents?: { agentId: string; loadedToolCount: number; schemaBytes: number; tools: { name: string }[]; error?: string }[]
}

const REGISTRY = Symbol.for('dsh.p7.mcp-tool-status.registry')

function registry(): Map<string, P7McpToolStatus> | undefined {
  return (globalThis as typeof globalThis & { [REGISTRY]?: Map<string, P7McpToolStatus> })[REGISTRY]
}

/** Read a detached public snapshot so the local HTTP route cannot expose Host internals. */
export function readP7McpToolStatus(profileId: string): P7McpToolStatus {
  const snapshot = registry()?.get(profileId)
  if (snapshot === undefined) return { phase: 'unavailable', tools: [] }
  return { phase: snapshot.phase, tools: snapshot.tools.map(tool => ({ name: tool.name })),
    ...(snapshot.mode ? { mode: snapshot.mode } : {}),
    ...(snapshot.authorizedToolCount === undefined ? {} : { authorizedToolCount: snapshot.authorizedToolCount }),
    ...(snapshot.agents ? { agents: snapshot.agents.map(agent => ({ agentId: agent.agentId,
      loadedToolCount: agent.loadedToolCount, schemaBytes: agent.schemaBytes,
      tools: agent.tools.map(tool => ({ name: tool.name })), ...(agent.error ? { error: agent.error } : {}) })) } : {}) }
}
