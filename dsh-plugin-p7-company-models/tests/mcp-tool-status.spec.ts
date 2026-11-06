import { describe, expect, it } from 'vitest'
import { readP7McpToolStatus, type P7McpToolStatus } from '../src/mcp-tool-status.js'

describe('P7 MCP tool status bridge', () => {
  it('returns only a detached public registration snapshot from the Host Symbol registry', () => {
    const profileId = 'profile-for-mcp-status-test'
    const symbol = Symbol.for('dsh.p7.mcp-tool-status.registry')
    const host = globalThis as typeof globalThis & { [symbol]?: Map<string, P7McpToolStatus> }
    const registry = host[symbol] ??= new Map()
    const tool = { name: 'mcp__p7__gildata__FinQuery', title: '金融查询', server: { name: '聚源数据', namespace: 'gildata' } }
    registry.set(profileId, { phase: 'registered', tools: [tool] })
    const snapshot = readP7McpToolStatus(profileId)
    snapshot.tools[0]!.name = 'changed-only-in-renderer-copy'
    snapshot.tools[0]!.server!.name = 'changed-only-in-renderer-copy'
    expect(readP7McpToolStatus(profileId)).toEqual({ phase: 'registered', tools: [tool] })
    registry.delete(profileId)
    expect(readP7McpToolStatus(profileId)).toEqual({ phase: 'unavailable', tools: [] })
  })
})
