import { describe, expect, it } from 'vitest'
import { readP7McpToolStatus } from '../src/mcp-tool-status.js'

describe('P7 MCP tool status bridge', () => {
  it('returns only a detached public registration snapshot from the Host Symbol registry', () => {
    const profileId = 'profile-for-mcp-status-test'
    const symbol = Symbol.for('dsh.p7.mcp-tool-status.registry')
    const host = globalThis as typeof globalThis & { [symbol]?: Map<string, { phase: 'registered'; tools: { name: string }[] }> }
    const registry = host[symbol] ??= new Map()
    registry.set(profileId, { phase: 'registered', tools: [{ name: 'mcp__p7__gildata__FinQuery' }] })
    const snapshot = readP7McpToolStatus(profileId)
    snapshot.tools[0]!.name = 'changed-only-in-renderer-copy'
    expect(readP7McpToolStatus(profileId)).toEqual({ phase: 'registered', tools: [{ name: 'mcp__p7__gildata__FinQuery' }] })
    registry.delete(profileId)
    expect(readP7McpToolStatus(profileId)).toEqual({ phase: 'unavailable', tools: [] })
  })
})
