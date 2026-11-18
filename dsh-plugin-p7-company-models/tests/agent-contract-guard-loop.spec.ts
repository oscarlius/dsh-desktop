import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools'
import { installAgentContractGuard } from '../src/agent-contract-guard.js'
import { installToolProgressGuard } from '../src/tool-progress-guard.js'

type Step = { tool: string; args: object } | { text: string; maxTokens?: true }
const say = (text = 'complete'): Step => ({ text })
const edit = (args: object): Step => ({ tool: 'edit', args })
const badEdit = () => edit({ file_path: 'fixture.txt', sandbox_permissions: 'use_default' })
const todos = (status: string): Step => ({ tool: 'todo_write', args: { todos: [{ content: 'finish the fixture', status }] } })
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

class ScriptedAdapter extends LlmAdapter {
  readonly requests = new Map<string, GenerateOptions[]>()
  readonly scripts = new Map<string, Step[]>()
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const key = String(options.sessionId)
    const requests = this.requests.get(key) ?? []
    requests.push(options); this.requests.set(key, requests)
    const step = this.scripts.get(key)?.shift()
    if (!step) throw new Error(`unexpected extra model request for ${key}`)
    if ('tool' in step) {
      const id = ToolCallId(`${key}-${requests.length}`)
      const args = JSON.stringify(step.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: step.tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: step.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
      yield { type: 'finish', reason: { kind: step.maxTokens ? 'max-tokens' : 'stop' } }
    }
  }
}

const disposals: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose() })

async function fixture() {
  const ctx = new Context()
  disposals.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections); await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolsService)
  await ctx.plugin(NativeExecutor); await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  // Same composition/order as the company plugin entry point.
  installToolProgressGuard(ctx)
  installAgentContractGuard(ctx)
  const bodies: object[] = []
  ctx.tools.register(defineTool({ name: 'edit', description: 'No filesystem access: validated edit fixture.',
    parameters: { file_path: { type: 'string', required: true }, sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } }, render: () => [{ type: 'text', text: 'edited' }] },
    async execute(args) { bodies.push(args); return { ok: true } },
  }))
  const todoItems = { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    content: { type: 'string', required: true }, status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
  } } } as const
  ctx.tools.register(defineTool({ name: 'todo_write', description: 'Canonical todo output fixture.', parameters: { todos: todoItems },
    output: { schema: { type: 'object', additionalProperties: false, properties: { todos: todoItems } }, render: () => [{ type: 'text', text: 'todo updated' }] },
    async execute(args) { return { todos: args.todos } },
  }))
  const create = async (id: string, script: Step[], parent?: Agent) => {
    adapter.scripts.set(id, script)
    const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'fixture', model: 'offline' },
      ...(parent ? { parentAgent: parent, meta: { parentSession: parent.session.id, origin: 'subagent', delegationDepth: 1 } } : {}) })
    disposals.push(() => handle.dispose())
    return handle.agent
  }
  return { ctx, adapter, bodies, create }
}

async function ask(agent: Agent, text = 'Complete the authorized fixture task.') {
  agent.followup(user(text)); await agent.whenIdle()
}
function outcome(agent: Agent) { return agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data.reason }
function notices(agent: Agent) {
  return agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'p7-agent-contract-guard')
    .flatMap(e => e.type === 'user/message' ? e.data.content : []).filter(b => b.type === 'text').map(b => b.text)
}

describe('agent contract guard on the actual RC1 AgentLoop', () => {
  it('repairs the observed enum failure after language steering without mutating or executing the invalid call', async () => {
    const f = await fixture()
    const agent = await f.create('language', [badEdit(), say('需要我继续吗？'), edit({ file_path: 'fixture.txt' }), say()])
    let steered = false
    f.ctx.on('tools/result', (exec, result) => {
      if (!steered && result.isError) { steered = true; exec.agent?.steer(user('为什么不用中文回我？')) }
    })
    await ask(agent)
    expect(f.bodies).toEqual([{ file_path: 'fixture.txt' }])
    expect(f.adapter.requests.get('language')).toHaveLength(4)
    expect(notices(agent).join('\n')).toContain('请省略该字段')
    expect(notices(agent).filter(t => t.includes('唯一一次'))).toHaveLength(1)
    expect(outcome(agent)).toEqual({ kind: 'completed' })
    const calls = agent.session.snapshotEvents().filter(e => e.type === 'tool/call')
    expect(JSON.stringify(calls)).toContain('use_default')
    expect(agent.session.snapshotEvents().filter(e => e.type === 'tool/result').some(e => e.data.message.isError)).toBe(true)
  })

  it('stops at the third invalid call even when the bad arguments vary', async () => {
    const f = await fixture()
    const agent = await f.create('invalid-limit', [badEdit(), edit({ sandbox_permissions: 'use_default' }), edit({ file_path: 42 })])
    await ask(agent)
    expect(f.bodies).toEqual([])
    expect(f.adapter.requests.get('invalid-limit')).toHaveLength(3)
    expect(notices(agent)).toHaveLength(2)
    expect(outcome(agent)).toMatchObject({ kind: 'aborted', reason: { kind: 'hook', reason: expect.stringContaining('3 invalid') } })
  })

  it('lets missing required arguments be regenerated, without guessing a file or a permission', async () => {
    const f = await fixture()
    const agent = await f.create('missing', [edit({}), edit({ file_path: 'fixture.txt' }), say()])
    await ask(agent)
    expect(f.bodies).toEqual([{ file_path: 'fixture.txt' }])
    expect(notices(agent)).toHaveLength(1)
    expect(notices(agent)[0]).not.toContain('请省略该字段')
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it('continues a pending todo once and accepts a subsequently completed list', async () => {
    const f = await fixture()
    const agent = await f.create('todo', [todos('in_progress'), say('需要我继续吗？'), todos('completed'), say()])
    await ask(agent)
    expect(notices(agent)).toHaveLength(1)
    expect(f.adapter.requests.get('todo')).toHaveLength(4)
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it('records an incomplete hook stop after the single continuation is ignored', async () => {
    const f = await fixture()
    const agent = await f.create('unfinished', [todos('pending'), say(), say()])
    await ask(agent)
    expect(f.adapter.requests.get('unfinished')).toHaveLength(3)
    expect(notices(agent)).toHaveLength(1)
    expect(outcome(agent)).toMatchObject({ kind: 'aborted', reason: { kind: 'hook', reason: expect.stringContaining('incomplete') } })
  })

  it('leaves ordinary answers and already-completed checklists alone', async () => {
    const f = await fixture()
    for (const [id, steps] of [['answer', [say()]], ['done', [todos('completed'), say()]]] as const) {
      const agent = await f.create(id, [...steps])
      await ask(agent)
      expect(notices(agent)).toEqual([])
      expect(outcome(agent)).toEqual({ kind: 'completed' })
    }
  })

  it('does not resume a real user cancellation with pending todos', async () => {
    const f = await fixture()
    const agent = await f.create('stop', [todos('pending')])
    f.ctx.on('tools/result', exec => { exec.agent?.cancel({ kind: 'user' }) })
    await ask(agent)
    expect(f.adapter.requests.get('stop')).toHaveLength(1)
    expect(notices(agent)).toEqual([])
    expect(outcome(agent)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  })

  it('respects explicit textual stop steering without clearing the original todo', async () => {
    const f = await fixture()
    const agent = await f.create('text-stop', [todos('pending'), say('已暂停')])
    f.ctx.on('tools/result', exec => { exec.agent?.steer(user('先暂停')) })
    await ask(agent)
    expect(notices(agent)).toEqual([])
    expect(f.adapter.requests.get('text-stop')).toHaveLength(2)
  })

  it('does not retry permission denial even with unfinished todos', async () => {
    const f = await fixture()
    f.ctx.on('tools/pre-execute', (exec, next) => exec.name === 'edit'
      ? Promise.resolve({ kind: 'deny' as const, reason: 'Permission denied by fixture policy.' }) : next())
    const agent = await f.create('denied', [todos('pending'), edit({ file_path: 'fixture.txt' }), say('需要权限')])
    await ask(agent)
    expect(f.bodies).toEqual([])
    expect(notices(agent)).toEqual([])
    expect(f.adapter.requests.get('denied')).toHaveLength(3)
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it('does not restart a max-token stop', async () => {
    const f = await fixture()
    const agent = await f.create('tokens', [todos('pending'), { text: 'partial', maxTokens: true }])
    await ask(agent)
    expect(notices(agent)).toEqual([])
    expect(outcome(agent)).toEqual({ kind: 'max-tokens' })
  })

  it('preserves a human-question tool conclusion without starting another model request', async () => {
    const f = await fixture()
    f.ctx.tools.register(defineTool({ name: 'ask_user', description: 'Concluding question fixture.', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'awaiting user' }] },
      async execute(_args, exec) { exec.concludeTurn(); return {} },
    }))
    const agent = await f.create('question', [todos('pending'), { tool: 'ask_user', args: {} }])
    await ask(agent)
    expect(notices(agent)).toEqual([])
    expect(f.adapter.requests.get('question')).toHaveLength(2)
    expect(outcome(agent)).toEqual({ kind: 'completed' })
  })

  it('honors a final post-execute policy block instead of treating the original tool result as success', async () => {
    const f = await fixture()
    f.ctx.on('tools/post-execute', (exec, _result, next) => exec.name === 'edit'
      ? Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'blocked by final policy' }] }) : next())
    const agent = await f.create('post-block', [todos('pending'), edit({ file_path: 'fixture.txt' }), say('blocked')])
    await ask(agent)
    expect(f.bodies).toHaveLength(1)
    expect(notices(agent)).toEqual([])
    expect(f.adapter.requests.get('post-block')).toHaveLength(3)
  })

  it('keeps parent and owned child budgets independent and resets on the next turn', async () => {
    const f = await fixture()
    const parent = await f.create('parent', [todos('pending'), say(), say()])
    const child = await f.create('child', [todos('pending'), say(), say()], parent)
    expect(f.ctx.agents.isOwnedBy(child.session.id, parent)).toBe(true)
    await Promise.all([ask(parent), ask(child)])
    for (const agent of [parent, child]) {
      expect(notices(agent)).toHaveLength(1)
      expect(outcome(agent)).toMatchObject({ kind: 'aborted', reason: { kind: 'hook' } })
    }
    f.adapter.scripts.set('parent', [say()])
    await ask(parent, 'Now answer a separate simple question.')
    expect(f.adapter.requests.get('parent')).toHaveLength(4)
    expect(outcome(parent)).toEqual({ kind: 'completed' })
  })
})
