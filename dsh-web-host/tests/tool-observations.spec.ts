import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installToolObservations } from '../src/tool-observations.js'
import { WebAccountBroker } from '../src/web-account.js'

const origin = 'https://portal.example'
const session = { id: 'example-session', header: { origin: 'interactive' } }
const subagent = { id: 'child-session', header: { origin: 'subagent' } }
const output = (text: string) => [{ type: 'text' as const, text }]
let home: string
const disposers = new Set<() => Promise<void>>()

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-tool-observations-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  await Promise.all([...disposers].map(dispose => dispose()))
  disposers.clear()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(home, { recursive: true, force: true })
})

function observe(token: string, userId = 'employee-1') {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const warn = vi.fn()
  const ctx = {
    on: (name: string, callback: (...args: unknown[]) => unknown) => listeners.set(name, callback),
    effect: (callback: () => () => Promise<void>) => disposers.add(callback()),
    logger: { warn },
  } as unknown as Context
  const account = new WebAccountBroker({ publicOrigin: origin }, async () => ({
    origin, instanceToken: token, expiresAt: Date.now() + 120_000, tokenType: 'Bearer',
    profile: { userId, organizationId: 'org-1', displayName: 'Employee', role: 'user', deviceId: 'device', sessionId: 'login', scopes: [] },
  }))
  installToolObservations(ctx, origin, account)
  const dispose = [...disposers].at(-1)!
  return {
    warn,
    dispose: async () => { await dispose(); disposers.delete(dispose) },
    emit(type: string, seq: number, data: object, extra?: object, owner = session) {
      listeners.get('session/event')!(owner, { type, seq, data, ...extra })
    },
    shell(callId: string, exitCode: number) {
      listeners.get('tools/result')!({ name: 'bash', callId, agent: { session } }, {
        isError: false, value: { kind: 'foreground', exitCode, stdout: { text: 'opaque credential' } },
      })
    },
  }
}

function call(observer: ReturnType<typeof observe>, seq: number, tool: string, args = {}, owner = session) {
  observer.emit('tool/call', seq, { turn: 1, step: 1, callId: `call-${seq}`, name: tool, arguments: JSON.stringify(args) }, {}, owner)
}

function result(observer: ReturnType<typeof observe>, seq: number, callSeq: number, text: string, code?: string, source = callSeq, owner = session) {
  const message = createToolResultMessage({ callId: `call-${callSeq}` as ToolCallId, content: output(text), isError: code !== undefined })
  observer.emit('tool/result', seq, {
    turn: 1, step: 1, message, ...(code ? { error: { name: 'ToolFailure', code } } : {}),
  }, { surfaceOp: 'append', sourceEventSeqs: [source] }, owner)
}

it('records paired native and PTC results by persisted sequence with bounded evidence', async () => {
  const send = vi.fn(async (_url: URL, _init: RequestInit) => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', send)
  const observer = observe('p7wi_example')
  observer.emit('turn/start', 0, { turn: 1 })
  call(observer, 1, 'read', { file_path: '/work/private/MEMPILOT-7Q4D.txt' })
  result(observer, 2, 1, 'mismatched source', undefined, 0)
  result(observer, 3, 1, 'Error: cannot read "/work/private/MEMPILOT-7Q4D.txt": not found', 'FS_NOT_FOUND')
  const write = { name: 'write', rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', arguments: { file_path: '/work/private/MEMPILOT-7Q4D.txt', content: 'opaque credential' } }
  observer.emit('tool/ptc-dispatch-start', 4, write)
  observer.emit('tool/ptc-dispatch', 5, { ...write, rootCallId: 'wrong', content: output('mismatched parent'), isError: false })
  observer.emit('tool/ptc-dispatch', 6, { ...write, content: output('opaque output'), isError: false })
  observer.emit('tool/ptc-dispatch', 7, { ...write, content: output('repeated result'), isError: false })
  call(observer, 8, 'read', { file_path: 'https://user:credentials@example.test/secret.txt' })
  result(observer, 9, 8, 'Error: credentials', 'CREDENTIALS_1234')
  call(observer, 10, 'bash', { command: 'opaque command' })
  observer.shell('call-10', 23)
  result(observer, 11, 10, '[exit code: 0]')
  call(observer, 12, 'bash', { command: 'opaque command' })
  observer.shell('call-12', 0)
  result(observer, 13, 12, 'Business operation failed\n[exit code: 23]')
  call(observer, 14, 'mkdir', { path: String.raw`C:\work\private\report-folder` })
  result(observer, 15, 14, 'cancelled', 'ABORTED_BEFORE_DISPATCH')
  call(observer, 16, 'search_company_memory', { query: 'opaque query' })
  result(observer, 17, 16, 'opaque recalled content')
  observer.emit('turn/start', 0, { turn: 1 }, {}, subagent)
  call(observer, 1, 'read', { file_path: 'subagent.txt' }, subagent)
  result(observer, 2, 1, 'subagent output', undefined, 1, subagent)
  observer.emit('turn/end', 18, { turn: 1, reason: { kind: 'completed' } })

  expect(send).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  const [url, request] = send.mock.calls[0]!
  expect(url.href).toBe(`${origin}/dsh/employee-memory/observations`)
  expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer p7wi_example', 'content-type': 'application/json' } })
  expect(JSON.parse(String(request.body))).toEqual({ session: session.id, events: [
    { seq: 3, turn: 1, tool: 'read', target: 'MEMPILOT-7Q4D.txt', status: 'failed', code: 'FS_NOT_FOUND', reason: 'File not found' },
    { seq: 6, turn: 1, tool: 'write', target: 'MEMPILOT-7Q4D.txt', status: 'succeeded' },
    { seq: 9, turn: 1, tool: 'read', status: 'failed', reason: 'Tool call failed' },
    { seq: 11, turn: 1, tool: 'bash', status: 'failed', code: 'EXIT_23', reason: 'Command exited with code 23' },
    { seq: 13, turn: 1, tool: 'bash', status: 'unknown' },
    { seq: 15, turn: 1, tool: 'mkdir', target: 'report-folder', status: 'cancelled', code: 'ABORTED_BEFORE_DISPATCH', reason: 'Tool call cancelled before dispatch' },
  ] })
})

it('replays unacknowledged records after restart under the same employee and caps each batch at 20', async () => {
  const send = vi.fn(async (_url: URL, _init: RequestInit) => new Response(null, { status: 503 }))
  vi.stubGlobal('fetch', send)
  const first = observe('p7wi_first')
  first.emit('turn/start', 0, { turn: 1 })
  for (let i = 1; i <= 23; i++) {
    call(first, i * 2, 'read', { file_path: 'report.txt' })
    result(first, i * 2 + 1, i * 2, 'some stdout')
  }
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  await first.dispose()
  const path = join(home, '.p7-tool-observations.json')
  const file = await readFile(path, 'utf8')
  expect(JSON.parse(file).entries).toHaveLength(23)
  expect(file).not.toMatch(/some stdout|p7wi_first|employee-1/)

  send.mockClear()
  const different = observe('p7wi_other', 'employee-other')
  await vi.waitFor(() => expect(different.warn).toHaveBeenCalled())
  expect(send).not.toHaveBeenCalled()
  await different.dispose()

  send.mockImplementation(async () => new Response(null, { status: 204 }))
  observe('p7wi_rotated')
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  const batches = send.mock.calls.map(([, request]) => JSON.parse(String(request.body)))
  expect(batches.map(batch => batch.events.length)).toEqual([20, 3])
  expect(batches.flatMap(batch => batch.events.map((event: { seq: number }) => event.seq))).toEqual(Array.from({ length: 23 }, (_, index) => index * 2 + 3))
  expect(send.mock.calls[0]![1].headers).toMatchObject({ authorization: 'Bearer p7wi_rotated' })
  await vi.waitFor(async () => expect(JSON.parse(await readFile(path, 'utf8')).entries).toEqual([]))
})
