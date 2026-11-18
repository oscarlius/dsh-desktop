import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import ToolsService, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ActivationStore } from '../src/activation-store.js'
import { resolveConfig } from '../src/config.js'
import { installLazyRuntime, LOAD_TOOL_NAME, SEARCH_TOOL_NAME } from '../src/lazy-runtime.js'

const signal = new AbortController().signal
const modelSelection = { provider: 'test', model: 'test-model' }

class FixtureAgents extends Service {
  static entries: Agent[] = []
  constructor(ctx: Context) { super(ctx, 'agents') }
  list(): Agent[] { return FixtureAgents.entries }
}

class FixtureWorkingDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure(): Promise<string> { return process.cwd() }
}

class SyntheticPtcRuntime extends PtcRuntime {
  readonly isolation = 'test'
  readonly language: 'typescript' | 'python'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = async () => ({ logs: [] })
  constructor(ctx: Context, config: { language?: 'typescript' | 'python' } = {}) {
    super(ctx)
    this.language = config.language ?? 'typescript'
  }
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? null }
  }
  run(request: PtcRunRequest): Promise<PtcRunResult> { return this.behavior(request) }
}

function agent(id: string): Agent {
  return { id, session: { header: { cwd: process.cwd() }, append() {} } } as unknown as Agent
}

function tool(name: string, value: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result as string }] },
    async execute() { return value },
  }
}

async function setup(agents: Agent[], mode: 'native' | 'ptc', language: 'typescript' | 'python' = 'typescript') {
  FixtureAgents.entries = agents
  const ctx = new Context()
  await ctx.plugin(FixtureAgents)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  for (const current of agents) Object.assign(current as object, { ctx })
  let ptc: SyntheticPtcRuntime | undefined
  if (mode === 'native') ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  else {
    await ctx.plugin(FixtureWorkingDirectory)
    await ctx.plugin(SyntheticPtcRuntime, { language })
    ptc = ctx.ptcRuntime as SyntheticPtcRuntime
    ctx.tools.setExecutor(new PtcExecutor(ctx))
  }
  return { ctx, ptc }
}

async function resolve(ctx: Context, current: Agent) {
  return await ctx.tools.resolve({ agent: current, modelSelection, signal })
}

async function load(ctx: Context, current: Agent, toolIds: string[]) {
  const helper = ctx.tools.get(LOAD_TOOL_NAME, current)
  if (!helper) throw new Error('load helper missing')
  await helper.execute({ toolIds }, { agent: current, signal } as never)
}

async function execute(ctx: Context, current: Agent | undefined, toolSet: Awaited<ReturnType<typeof resolve>> | undefined, name: string, argumentsValue: unknown) {
  return await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId(`call-${name}`), name, arguments: JSON.stringify(argumentsValue) }],
    signal,
    ...(current ? { agent: current } : {}),
    ...(toolSet ? { toolSet } : {}),
  })
}

function resultText(batch: Awaited<ReturnType<typeof execute>>): string {
  const result = batch.results[0]?.result
  return JSON.stringify(result?.content ?? [])
}

function install(ctx: Context, store: ActivationStore<Agent>) {
  const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand' }))
  ctx.tools.register(tool('local_info', 'local'), undefined)
  ctx.tools.register(tool('p7_finance__quote', 'quote'), runtime.registrationOptions('p7_finance__quote'))
  ctx.tools.register(tool('p7_macro__gdp', 'macro'), runtime.registrationOptions('p7_macro__gdp'))
  return runtime
}

describe('executor admission follows lazy ToolSet snapshots', () => {
  it('keeps native schemas and dispatch scoped to the resolved Agent ToolSet', async () => {
    const parent = agent('native-parent')
    const sibling = agent('native-sibling')
    const { ctx } = await setup([parent, sibling], 'native')
    const store = new ActivationStore<Agent>({ nameMapper: wire => `p7_${wire}` })
    store.publishCatalog([
      { name: 'finance__quote', description: 'quote', inputSchema: { type: 'object' } },
      { name: 'macro__gdp', description: 'macro', inputSchema: { type: 'object' } },
    ])
    const runtime = install(ctx, store)
    try {
      const oldSet = await resolve(ctx, parent)
      expect(ctx.tools.schemas(parent, oldSet).map(schema => schema.name).sort()).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME, 'local_info'].sort())
      await load(ctx, parent, ['p7_finance__quote'])
      expect(ctx.tools.schemas(parent, oldSet).map(schema => schema.name)).not.toContain('p7_finance__quote')
      expect(resultText(await execute(ctx, parent, oldSet, 'p7_finance__quote', {}))).toContain('unknown tool')

      const freshSet = await resolve(ctx, parent)
      expect(ctx.tools.schemas(parent, freshSet).map(schema => schema.name)).toContain('p7_finance__quote')
      expect(resultText(await execute(ctx, parent, freshSet, 'p7_finance__quote', {}))).toContain('quote')
      const siblingSet = await resolve(ctx, sibling)
      expect(resultText(await execute(ctx, sibling, siblingSet, 'p7_finance__quote', {}))).toContain('P7_MCP_TOOL_NOT_LOADED')
      expect(resultText(await execute(ctx, undefined, undefined, 'p7_finance__quote', {}))).toContain('P7_MCP_AGENT_SCOPE_REQUIRED')
      oldSet.dispose(); freshSet.dispose(); siblingSet.dispose()
    } finally { runtime.dispose(); await ctx.fiber.dispose() }
  })

  it.each(['typescript', 'python'] as const)('renders only loaded MCP declarations in the real %s PTC SDK', async (language) => {
    const current = agent(`ptc-${language}`)
    const { ctx } = await setup([current], 'ptc', language)
    const store = new ActivationStore<Agent>({ nameMapper: wire => `p7_${wire}` })
    store.publishCatalog([
      { name: 'finance__quote', description: 'quote', inputSchema: { type: 'object' } },
      { name: 'macro__gdp', description: 'macro', inputSchema: { type: 'object' } },
    ])
    const runtime = install(ctx, store)
    try {
      const initialSet = await resolve(ctx, current)
      const initial = await ctx.systemPrompt.assemble({ scope: current, toolSet: initialSet })
      const initialSdk = initial.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      const discovery = initial.sections.find(section => section.name === 'p7-mcp:on-demand-discovery')?.text ?? ''
      expect(initial.tools.map(schema => schema.name)).toEqual(['run_code'])
      expect(initialSdk).toContain('local_info')
      expect(initialSdk).not.toContain('p7_finance__quote')
      expect(initialSdk).not.toContain('p7_macro__gdp')
      expect(discovery).toContain('financial or market-data')
      expect(discovery).toContain(SEARCH_TOOL_NAME)
      expect(discovery).toContain('Do not repeat search or load for an already-loaded match')
      expect(discovery).not.toContain('p7_finance__quote')

      await load(ctx, current, ['p7_finance__quote'])
      const loadedSet = await resolve(ctx, current)
      const loaded = await ctx.systemPrompt.assemble({ scope: current, toolSet: loadedSet })
      const loadedSdk = loaded.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      expect(loadedSdk).toContain('p7_finance__quote')
      expect(loadedSdk).not.toContain('p7_macro__gdp')
      expect(loaded.sections.find(section => section.name === 'p7-mcp:on-demand-discovery')?.text).toBe(discovery)
      initialSet.dispose(); loadedSet.dispose()
    } finally { runtime.dispose(); await ctx.fiber.dispose() }
  })

  it('routes only loaded PTC bindings through the shared invocation pipeline', async () => {
    const current = agent('ptc-dispatch')
    const { ctx, ptc } = await setup([current], 'ptc')
    const store = new ActivationStore<Agent>({ nameMapper: wire => `p7_${wire}` })
    store.publishCatalog([
      { name: 'finance__quote', description: 'quote', inputSchema: { type: 'object' } },
      { name: 'macro__gdp', description: 'macro', inputSchema: { type: 'object' } },
    ])
    const runtime = install(ctx, store)
    try {
      const initialSet = await resolve(ctx, current)
      ptc!.behavior = async request => {
        const functions = request.bindings.find(binding => binding.global === 'tools')!.functions
        return { logs: [], value: { hasLoaded: typeof functions.p7_finance__quote, hasGuessed: typeof functions.p7_macro__gdp } }
      }
      const before = await execute(ctx, current, initialSet, 'run_code', { code: 'return null', description: 'probe' })
      expect(resultText(before)).toContain('hasLoaded')
      expect(resultText(before)).toContain('undefined')

      await load(ctx, current, ['p7_finance__quote'])
      const loadedSet = await resolve(ctx, current)
      ptc!.behavior = async request => {
        const functions = request.bindings.find(binding => binding.global === 'tools')!.functions
        expect(functions.p7_macro__gdp).toBeUndefined()
        return { logs: [], value: await functions.p7_finance__quote!({}) }
      }
      expect(resultText(await execute(ctx, current, loadedSet, 'run_code', { code: 'return null', description: 'dispatch' }))).toContain('quote')
      initialSet.dispose(); loadedSet.dispose()
    } finally { runtime.dispose(); await ctx.fiber.dispose() }
  })
})
