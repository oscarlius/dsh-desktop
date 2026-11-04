import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolsService from '@deepseek-ai/dsh-tools'
import { installToolProgressGuard } from '../src/tool-progress-guard.js'

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly steps: readonly string[]) { super() }
  private calls = 0
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const name = this.steps[this.calls++]
    if (name === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'complete' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    const id = ToolCallId(`fixture-${this.calls}`); const argumentsValue = JSON.stringify({ stable: name === 'retry' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsValue }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsValue } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

async function run(steps: readonly string[], secondUserRequest = false) {
  const ctx = new Context(); const adapter = new ScriptedAdapter(steps); let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
  const executions: string[] = []
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolsService); await ctx.plugin(NativeExecutor); await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['fixture'], adapter); installToolProgressGuard(ctx, { patternWindow: 2, repeatedPatternThreshold: 2, maxDistinctPatterns: 1 })
    for (const name of ['retry', 'first', 'second', 'empty']) ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, async execute() { executions.push(name); return name === 'retry' ? { isError: true, content: 'fixed fixture error' } : { content: name === 'empty' ? '(no output)' : name } } })
    handle = await ctx.agents.create({ sessionId: SessionId('guard-loop'), agentOptions: { provider: 'fixture', model: 'offline' } })
    const ask = () => handle!.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fixture' }], source: { kind: 'user' } }))
    ask(); await handle.agent.whenIdle(); if (secondUserRequest) { ask(); await handle.agent.whenIdle() }
    return executions
  } finally { await handle?.dispose(); await ctx.fiber.dispose() }
}

it('cancels a real AgentLoop after repeated no-progress tool failures', async () => {
  expect(await run(['retry', 'retry', 'retry'])).toEqual(['retry', 'retry'])
}, 15_000)

it('stops repeated successful empty results instead of requiring a tool error', async () => {
  // The observed incident repeatedly queried an exhausted result slice: the
  // command succeeded with no output, so error-only retry limits did not help.
  expect(await run(['empty', 'empty', 'empty'])).toEqual(['empty', 'empty'])
}, 15_000)

it('permits distinct tools and a normal text completion, and resets for a new user request', async () => {
  expect(await run(['first', 'second'])).toEqual(['first', 'second'])
  expect(await run(['retry', 'retry', 'retry'], true)).toEqual(['retry', 'retry', 'retry'])
}, 15_000)

it('bounds the observed successful-empty pattern independently in parent and owned child loops', async () => {
  const ctx = new Context(); const handles = []; const requests = new Map<string, number>(); const executions = new Map<object, number>()
  class EmptyCommandAdapter extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const session = String(options.sessionId); const count = (requests.get(session) ?? 0) + 1; requests.set(session, count)
      if (count > 8) throw new Error('loop guard allowed an extra model request')
      const id = ToolCallId(`${session}-${count}`); const args = JSON.stringify({ command: 'Select-Object -Skip 40 -First 40' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'pwsh', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'pwsh', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections); await ctx.plugin(AgentRegistry); await ctx.plugin(LlmRuntime); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolsService); await ctx.plugin(NativeExecutor); await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin({ name: 'company-guard-fixture', apply: (pluginContext: Context) => installToolProgressGuard(pluginContext) })
    ctx.llm.registerAdapter(['fixture'], new EmptyCommandAdapter())
    ctx.tools.register({ name: 'pwsh', description: 'empty foreground command fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '(no output)' }] },
      async execute(_args, exec) { expect(exec.agent).toBeDefined(); const agent = exec.agent!; executions.set(agent, (executions.get(agent) ?? 0) + 1); return { exitCode: 0, stdout: '', stderr: '' } } })
    const parent = await ctx.agents.create({ sessionId: SessionId('empty-parent'), agentOptions: { provider: 'fixture', model: 'offline' } }); handles.push(parent)
    const child = await ctx.agents.create({ sessionId: SessionId('empty-child'), parentAgent: parent.agent, meta: { parentSession: SessionId('empty-parent'), origin: 'subagent', delegationDepth: 1 }, agentOptions: { provider: 'fixture', model: 'offline' } }); handles.push(child)
    expect(ctx.agents.isOwnedBy(SessionId('empty-child'), parent.agent)).toBe(true)
    for (const handle of handles) {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'exhausted slice fixture' }], source: { kind: 'user' } })); await handle.agent.whenIdle()
    }
    expect([...requests.values()]).toEqual([8, 8]); expect([...executions.values()]).toEqual([8, 8])
  } finally { for (const handle of handles.reverse()) await handle.dispose(); await ctx.fiber.dispose() }
}, 15_000)
