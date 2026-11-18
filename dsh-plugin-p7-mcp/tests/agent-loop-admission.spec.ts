import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolsService from '@deepseek-ai/dsh-tools'
import { ActivationStore } from '../src/activation-store.js'
import { resolveConfig } from '../src/config.js'
import { installLazyRuntime, LOAD_TOOL_NAME, SEARCH_TOOL_NAME } from '../src/lazy-runtime.js'

// The model is scripted; registry, owned Agents, loop, admission and dispatch are real rc.1.
class ScriptedAdapter extends LlmAdapter {
  readonly requests = new Map<string, string[][]>()
  constructor(private readonly desired: ReadonlyMap<string, string>, private readonly discovery: typeof LOAD_TOOL_NAME | typeof SEARCH_TOOL_NAME) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId)
    const desired = this.desired.get(sessionId)
    if (!desired) throw new Error(`Unexpected fixture session ${sessionId}`)
    const history = this.requests.get(sessionId) ?? []
    this.requests.set(sessionId, history)
    const step = history.length
    history.push((options.tools ?? []).map(tool => tool.name).sort())
    if (step < 2) {
      const name = step === 0 ? this.discovery : desired
      const args = JSON.stringify(step === 0 ? this.discovery === SEARCH_TOOL_NAME ? { query: desired } : { toolIds: [desired] } : {})
      const id = ToolCallId(`${sessionId}-${step}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'fixture complete' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture complete' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it.each([LOAD_TOOL_NAME, SEARCH_TOOL_NAME] as const)('runs real parent and owned child AgentLoops with one %s discovery step', async (discovery) => {
  const ctx = new Context()
  const parentId = SessionId('mcp-loop-parent')
  const childId = SessionId('mcp-loop-child')
  const quote = 'p7_finance__quote'
  const macro = 'p7_macro__cpi'
  const adapter = new ScriptedAdapter(new Map([[parentId, quote], [childId, macro]]), discovery)
  const calls: { name: string; agent: Agent | undefined }[] = []
  const handles: AgentHandle[] = []
  let lazy: ReturnType<typeof installLazyRuntime> | undefined
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolsService)
    await ctx.plugin(NativeExecutor)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['fixture'], adapter)
    const store = new ActivationStore<Agent>({ nameMapper: name => `p7_${name}` })
    store.publishCatalog([
      { name: 'finance__quote', description: 'daily quotes', inputSchema: { type: 'object', properties: {} } },
      { name: 'macro__cpi', description: 'CPI observations', inputSchema: { type: 'object', properties: {} } },
    ])
    lazy = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand' }))
    for (const name of [quote, macro]) {
      ctx.tools.register({
        name, description: name, parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
        async execute(_args, exec) {
          calls.push({ name, agent: exec.agent })
          return { source: 'synthetic-fixture', effectiveDate: '2026-11-04' }
        },
      }, lazy.registrationOptions(name))
    }
    const parent = await ctx.agents.create({ sessionId: parentId, agentOptions: { provider: 'fixture', model: 'offline' } })
    handles.push(parent)
    parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'load quote' }], source: { kind: 'user' } }))
    await parent.agent.whenIdle()
    const child = await ctx.agents.create({
      sessionId: childId, parentAgent: parent.agent,
      meta: { origin: 'subagent', parentSession: parentId, delegationDepth: 1 },
      agentOptions: { provider: 'fixture', model: 'offline' },
    })
    handles.push(child)
    expect(ctx.agents.isOwnedBy(childId, parent.agent)).toBe(true)
    child.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'load CPI' }], source: { kind: 'user' } }))
    await child.agent.whenIdle()
    const helpers = [LOAD_TOOL_NAME, SEARCH_TOOL_NAME].sort()
    expect(adapter.requests.get(parentId)).toEqual([helpers, [...helpers, quote].sort(), [...helpers, quote].sort()])
    expect(adapter.requests.get(childId)).toEqual([helpers, [...helpers, macro].sort(), [...helpers, macro].sort()])
    expect(calls).toEqual([{ name: quote, agent: parent.agent }, { name: macro, agent: child.agent }])
    expect(store.active(parent.agent, () => true).map(entry => entry.publicName)).toEqual([quote])
    expect(store.active(child.agent, () => true).map(entry => entry.publicName)).toEqual([macro])
    await child.dispose()
    handles.pop()
    expect(store.active(child.agent, () => true)).toEqual([])
    expect(store.active(parent.agent, () => true)).toHaveLength(1)
  } finally {
    for (const handle of handles.reverse()) await handle.dispose()
    lazy?.dispose()
    await ctx.fiber.dispose()
  }
}, 15_000)
