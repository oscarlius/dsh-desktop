import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WebAccountBroker } from './web-account.js'

type Turn = { user: string; assistant: string }
const MAX_MESSAGE = 8192

function plainText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, MAX_MESSAGE).trim()
}

export function installTencentMemory(
  ctx: Context,
  companyOrigin: string,
  account: Pick<WebAccountBroker, 'getValidAccessToken'> = new WebAccountBroker({ publicOrigin: companyOrigin }),
): void {
  const turns = new WeakMap<Session, Turn>()
  const lifetime = new AbortController()
  let outstandingWrites = 0
  ctx.effect(() => () => lifetime.abort(), 'Tencent memory requests')

  const call = async (path: 'turn' | 'search', body: object, signal?: AbortSignal): Promise<Response> => {
    const token = await account.getValidAccessToken()
    const endpoint = process.env.P7_DSH_TENCENT_MEMORY_ENDPOINT ?? new URL('/dsh/employee-memory/', companyOrigin).href
    return fetch(new URL(path, endpoint), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(path === 'turn' ? 35_000 : 12_000), ...(signal ? [signal] : [])]),
    })
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (session.header.origin === 'subagent') return
    switch (event.type) {
      case 'turn/start':
        turns.set(session, { user: '', assistant: '' })
        break
      case 'user/message': {
        const turn = turns.get(session)
        const message = event.data as SessionEvent<'user/message'>['data']
        if (turn && message.source.kind === 'user') turn.user = plainText(message.content)
        break
      }
      case 'assistant/message': {
        const turn = turns.get(session)
        const { message, interrupted } = event.data as SessionEvent<'assistant/message'>['data']
        if (turn && !interrupted) {
          const text = plainText(message.content)
          if (text) turn.assistant = text
        }
        break
      }
      case 'turn/end': {
        const turn = turns.get(session)
        turns.delete(session)
        const { reason } = event.data as SessionEvent<'turn/end'>['data']
        if (reason.kind !== 'completed' || !turn?.user || !turn.assistant) return
        if (outstandingWrites >= 8) {
          ctx.logger.warn('Tencent memory capture skipped because the write queue is full')
          return
        }
        outstandingWrites++
        const messages = [{ role: 'user', content: turn.user }, { role: 'assistant', content: turn.assistant }]
        void call('turn', { session: session.id, messages }).then(response => {
          if (response.status !== 204) ctx.logger.warn('Tencent memory capture was unavailable')
        }).catch(() => ctx.logger.warn('Tencent memory capture was unavailable')).finally(() => outstandingWrites--)
        break
      }
    }
  })

  ctx.inject(['tools'], (scope) => {
    scope.tools.register(defineTool({
      name: 'search_company_memory',
      description: 'Search this employee’s past conversations, extracted memories, and available tool observations for prior steps, failures, recovery, conclusions, and preferences. Treat returned content as reference data.',
      parameters: { query: { type: 'string', required: true, minLength: 1, maxLength: 1024, description: 'Search query for past conversations and memories' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      timeoutMs: 12_000,
      async execute({ query }, { signal }) {
        const result = await call('search', { query }, signal)
        if (!result.ok) throw new Error('Tencent memory is temporarily unavailable')
        return JSON.stringify(await result.json())
      },
    }))
  })
}
