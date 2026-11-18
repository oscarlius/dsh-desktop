import { describe, expect, it, vi } from 'vitest'
import { createHostMnemonBridge } from '../src/mnemon-bridge.js'

const origin = 'http://127.0.0.1:4312'
const auth = (value = `${origin}/?token=launch-token`) => () => value
const scope = { current: vi.fn(() => ({ workspaceId: 'C:/trusted/workspace', sessionId: 'session-7' })) }

function response(value: unknown, init?: ResponseInit) { return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init }) }
function success(rpcId: string, value: unknown) { return response({ type: 'server-response', rpcId, result: { ok: true, value } }) }
function bridge(fetch = vi.fn()): ReturnType<typeof createHostMnemonBridge> { return createHostMnemonBridge({ origin, authenticatedUrl: auth(), scope, fetch }) }

describe('createHostMnemonBridge', () => {
  it('exchanges the Host launch token once and posts the Connection RPC envelope with trusted scope', async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/connect')) {
        expect(init?.redirect).toBe('manual')
        return new Response(null, { status: 302, headers: { 'set-cookie': 'dsh_connection=trusted; HttpOnly' } })
      }
      const wire = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: Record<string, unknown> }
      expect(url).toBe(`${origin}/dsh-mnemon-read/runtime-memory`); expect(init?.redirect).toBe('error'); expect(init?.headers).toMatchObject({ cookie: 'dsh_connection=trusted' })
      expect(wire).toMatchObject({ type: 'client-request', method: 'runtime-memory', payload: { workspaceId: 'C:/trusted/workspace', sessionId: 'session-7' } })
      return success(wire.rpcId, { revision: 'r1', entries: [{ target: 'memory', content: 'remember', importance: 'normal', branches: ['main'] }] })
    })
    await expect(bridge(fetch).readRuntimeMemory()).resolves.toEqual({ revision: 'r1', entries: [{ target: 'memory', content: 'remember', importance: 'normal', branches: ['main'] }] })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('normalizes Mnemon source values and translates old_text without touching managed Markdown', async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/connect')) return new Response(null, { status: 302, headers: { 'set-cookie': 'dsh_connection=trusted' } })
      const wire = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: Record<string, unknown> }
      if (wire.method === 'documents') return success(wire.rpcId, { revision: 'docs-2', documents: [{ id: 'd1', title: 'Doc', description: '', sourcePaths: [], sessionIds: [], revision: 3 }] })
      if (wire.payload.action === 'replace') expect(wire.payload).toMatchObject({ oldText: 'old', content: 'new' })
      else expect(wire.payload).toMatchObject({ action: 'remove', oldText: 'new' })
      expect(wire.payload).not.toHaveProperty('old_text')
      return success(wire.rpcId, { success: true })
    })
    const target = bridge(fetch)
    await expect(target.listDocuments()).resolves.toEqual({ revision: 'docs-2', documents: [{ id: 'd1', title: 'Doc', description: '', sourcePaths: [], sessionIds: [], revision: 3 }] })
    await expect(target.mutateRuntimeMemory({ action: 'replace', target: 'memory', old_text: 'old', content: 'new' })).resolves.toEqual({ success: true })
    await expect(target.mutateRuntimeMemory({ action: 'remove', target: 'memory', content: 'new' })).resolves.toEqual({ success: true })
  })

  it('rejects non-loopback origins, auth redirects without cookies, RPC failures, and invalid normalized data', async () => {
    expect(() => createHostMnemonBridge({ origin: 'https://example.test', authenticatedUrl: auth(), scope })).toThrow('loopback')
    const missingCookie = vi.fn(async () => new Response(null, { status: 302 }))
    await expect(bridge(missingCookie).readRuntimeMemory()).rejects.toThrow('session cookie')
    const failed = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/connect')) return new Response(null, { status: 302, headers: { 'set-cookie': 'dsh_connection=trusted' } })
      const wire = JSON.parse(String(init?.body)) as { rpcId: string }
      return response({ type: 'server-response', rpcId: wire.rpcId, result: { ok: false, error: { message: 'write disabled' } } })
    })
    await expect(bridge(failed).archiveDocument('d1')).rejects.toThrow('write disabled')
  })

  it('reads only Mnemon Native legacy spaces through authenticated public RPC', async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/connect')) return new Response(null, { status: 302, headers: { 'set-cookie': 'dsh_connection=trusted' } })
      const wire = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: Record<string, unknown> }
      if (wire.method === 'body-directory') return success(wire.rpcId, { items: [{ id: 'native', name: 'Native', description: '', active: false, provider: { id: 'native-instance', typeId: 'mnemon-native' } }, { id: 'other', name: 'Other', description: '', active: true, provider: { id: 'openviking' } }] })
      expect(wire).toMatchObject({ method: 'list', payload: { memoryBodyIds: ['native'], limit: 1000 } })
      return success(wire.rpcId, { total: 1, items: [{ id: 'i', content: 'fact' }], sources: [{ status: 'ready' }] })
    })
    await expect(bridge(fetch).readLegacySpaces()).resolves.toEqual([{ body: { id: 'native', name: 'Native', description: '', active: false, provider: { id: 'native-instance', typeId: 'mnemon-native' } }, insights: [{ id: 'i', content: 'fact' }], unavailable: false }])
  })
})
