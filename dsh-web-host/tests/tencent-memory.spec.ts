import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { installTencentMemory } from '../src/tencent-memory.js'

afterEach(() => vi.unstubAllGlobals())

it('records a completed human turn with the server-side workload credential', async () => {
  const send = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', send)
  let listener: (session: unknown, event: unknown) => void = () => { throw Error('no listener') }
  const ctx = {
    on: (name: string, callback: typeof listener) => { if (name === 'session/event') listener = callback },
    inject: () => {},
    effect: () => {},
    logger: { warn: vi.fn() },
  } as unknown as Context
  const getValidAccessToken = vi.fn(async () => 'p7wi_synthetic')
  installTencentMemory(ctx, 'https://portal.example', { getValidAccessToken })

  const session = { id: 'synthetic-session', header: {} } as unknown as Session
  const emit = (type: string, data: object = {}) => listener(session, { type, data } as SessionEvent)
  const messages = (text: string, kind: string) => ({ source: { kind }, content: [{ type: 'text', text }] })
  emit('turn/start')
  emit('user/message', messages('Synthetic user input.', 'user'))
  emit('user/message', messages('Injected internal context.', 'system'))
  emit('assistant/message', { message: messages('Synthetic answer.', 'model') })
  emit('assistant/message', { message: { content: [] } })
  emit('turn/end', { reason: { kind: 'completed' } })
  emit('turn/start')
  emit('user/message', messages('Aborted input.', 'user'))
  emit('assistant/message', { message: messages('Result.', 'model'), interrupted: true })
  emit('turn/end', { reason: { kind: 'aborted' } })

  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(send).toHaveBeenCalledWith(new URL('https://portal.example/dsh/employee-memory/turn'), expect.objectContaining({
    headers: { authorization: 'Bearer p7wi_synthetic', 'content-type': 'application/json' },
    body: JSON.stringify({
      session: 'synthetic-session',
      messages: [{ role: 'user', content: 'Synthetic user input.' }, { role: 'assistant', content: 'Synthetic answer.' }],
    }),
  }))
})
