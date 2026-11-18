import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { ActivationStore } from '../src/activation-store.js'
import { resolveConfig } from '../src/config.js'
import { installLazyRuntime, LOAD_TOOL_NAME, SEARCH_TOOL_NAME } from '../src/lazy-runtime.js'

const signal = new AbortController().signal
const selection = { provider: 'test', model: 'test-model' }

class FixtureAgents extends Service {
  static entries: Agent[] = []
  constructor(ctx: Context) { super(ctx, 'agents') }
  list(): Agent[] { return FixtureAgents.entries }
}

function agent(id: string): Agent { return { id } as Agent }

function businessTool(name: string, description = `${name} business tool`): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute() { return {} },
  }
}

async function setup(initialAgents: Agent[] = []) {
  const ctx = new Context()
  // This is only the public live-registry list seam; tool resolution,
  // filtering, guards, and schemas below are real rc1 services.
  FixtureAgents.entries = initialAgents
  await ctx.plugin(FixtureAgents)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  return ctx
}

async function scopeFor(ctx: Context, key: Agent): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) }, { inject: ['tools', 'systemPrompt'] }))
  return scope
}

async function resolve(ctx: Context, current: Agent) {
  return await ctx.tools.resolve({ agent: current, modelSelection: selection, signal })
}

function names(ctx: Context, current: Agent, toolSet: Awaited<ReturnType<typeof resolve>>): string[] {
  return ctx.tools.schemas(current, toolSet).map(tool => tool.name).sort()
}

async function callLoad(ctx: Context, current: Agent, toolIds: string[]) {
  const definition = ctx.tools.get(LOAD_TOOL_NAME, current)
  if (!definition) throw new Error('load helper missing')
  return await definition.execute({ toolIds }, { agent: current, signal } as never)
}

async function callSearch(ctx: Context, current: Agent, query: string) {
  const definition = ctx.tools.get(SEARCH_TOOL_NAME, current)
  if (!definition) throw new Error('search helper missing')
  return await definition.execute({ query }, { agent: current, signal } as never)
}

describe('installLazyRuntime with rc1 ToolsService', () => {
  it('admits only helpers until a load changes the following resolved ToolSet, isolated by Agent identity', async () => {
    const parent = agent('parent')
    const child = agent('child')
    const ctx = await setup([parent, child])
    const store = new ActivationStore<Agent>({ nameMapper: wireName => `p7_${wireName}` })
    store.publishCatalog([{ name: 'finance__quote', description: 'market quote', inputSchema: { type: 'object' } }])
    const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand' }))
    ctx.tools.register(businessTool('p7_finance__quote'), runtime.registrationOptions('p7_finance__quote'))
    try {
      const before = await resolve(ctx, parent)
      expect(names(ctx, parent, before)).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME])
      await callLoad(ctx, parent, ['p7_finance__quote'])
      // A resolved set is a step snapshot; helper execution cannot mutate it.
      expect(names(ctx, parent, before)).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME])
      const after = await resolve(ctx, parent)
      expect(names(ctx, parent, after)).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME, 'p7_finance__quote'].sort())
      const sibling = await resolve(ctx, child)
      expect(names(ctx, child, sibling)).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME])
      before.dispose(); after.dispose(); sibling.dispose()
    } finally { runtime.dispose(); await ctx.fiber.dispose() }
  })

  it('honors a real scoped policy and bootstraps a fixed business-only filter without adding helpers', async () => {
    const fixed = agent('fixed')
    const ctx = await setup([fixed])
    const scope = await scopeFor(ctx, fixed)
    const store = new ActivationStore<Agent>({ nameMapper: wireName => `p7_${wireName}` })
    store.publishCatalog([
      { name: 'finance__quote', description: 'market quote', inputSchema: { type: 'object' } },
      { name: 'macro__gdp', description: 'macro data', inputSchema: { type: 'object' } },
    ])
    // Definitions are globally registered; this exact Agent sees only quote.
    const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand' }))
    ctx.tools.register(businessTool('p7_finance__quote'), runtime.registrationOptions('p7_finance__quote'))
    ctx.tools.register(businessTool('p7_macro__gdp'), runtime.registrationOptions('p7_macro__gdp'))
    scope.ctx.tools.restrict({ allow: ['p7_finance__quote'] })
    try {
      runtime.refresh()
      const admitted = await resolve(ctx, fixed)
      expect(names(ctx, fixed, admitted)).toEqual(['p7_finance__quote'])
      expect(ctx.tools.schemas(fixed).map(tool => tool.name)).toEqual(['p7_finance__quote'])
      admitted.dispose()
    } finally { runtime.dispose(); await scope.dispose(); await ctx.fiber.dispose() }
  })

  it('fails closed for guessed, agentless, invalidated, and disposed business calls', async () => {
    const current = agent('guarded')
    const ctx = await setup([current])
    const store = new ActivationStore<Agent>({ nameMapper: wireName => `p7_${wireName}` })
    store.publishCatalog([{ name: 'finance__quote', description: 'market quote', inputSchema: { type: 'object' } }])
    const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand' }))
    ctx.tools.register(businessTool('p7_finance__quote'), runtime.registrationOptions('p7_finance__quote'))
    try {
      expect(ctx.tools.checkGuards({ name: 'p7_finance__quote', agent: current } as ToolExecution)).toBe('P7_MCP_TOOL_NOT_LOADED')
      expect(ctx.tools.checkGuards({ name: 'p7_finance__quote' } as ToolExecution)).toBe('P7_MCP_AGENT_SCOPE_REQUIRED')
      await callLoad(ctx, current, ['p7_finance__quote'])
      expect(ctx.tools.checkGuards({ name: 'p7_finance__quote', agent: current } as ToolExecution)).toBeUndefined()
      store.invalidateCatalog()
      expect(ctx.tools.checkGuards({ name: 'p7_finance__quote', agent: current } as ToolExecution)).toBe('P7_MCP_CATALOG_UNAVAILABLE')
      runtime.dispose()
      expect(ctx.tools.get(LOAD_TOOL_NAME, current)).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects unavailable rc3-style contexts and fixed filters that exceed the configured budget', async () => {
    const unsupported = new Context()
    const store = new ActivationStore<Agent>({ nameMapper: wireName => `p7_${wireName}`, maxLoadedTools: 1 })
    expect(() => installLazyRuntime(unsupported, store, resolveConfig({ mode: 'on-demand' }))).toThrow('P7_MCP_ON_DEMAND_REQUIRES_RC1_AGENT_SERVICES')

    const fixed = agent('over-budget')
    const ctx = await setup([fixed])
    const scope = await scopeFor(ctx, fixed)
    store.publishCatalog([
      { name: 'finance__quote', description: 'market quote', inputSchema: { type: 'object' } },
      { name: 'macro__gdp', description: 'macro data', inputSchema: { type: 'object' } },
    ])
    ctx.tools.register(businessTool('p7_finance__quote'))
    ctx.tools.register(businessTool('p7_macro__gdp'))
    scope.ctx.tools.restrict({ allow: ['p7_finance__quote', 'p7_macro__gdp'] })
    try {
      expect(() => installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand', maxLoadedTools: 1 }))).toThrow('P7_MCP_FIXED_PRESET_TOOL_LIMIT')
    } finally { await scope.dispose(); await ctx.fiber.dispose() }
  })

  it('does not reuse a disposed Agent identity after it leaves the live registry', async () => {
    const current = agent('disposed')
    const agents = [current]
    const ctx = await setup(agents)
    const store = new ActivationStore<Agent>({ nameMapper: wireName => `p7_${wireName}` })
    store.publishCatalog([{ name: 'finance__quote', description: 'market quote', inputSchema: { type: 'object' } }])
    const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand' }))
    ctx.tools.register(businessTool('p7_finance__quote'), runtime.registrationOptions('p7_finance__quote'))
    try {
      await callLoad(ctx, current, ['p7_finance__quote'])
      agents.splice(0, 1)
      ctx.emit('agent/disposed', { agent: current })
      expect(runtime.registrationOptions('p7_finance__quote').when?.({ agent: current, modelSelection: selection, signal })).toBe(false)
      expect(ctx.tools.checkGuards({ name: 'p7_finance__quote', agent: current } as ToolExecution)).toBe('P7_MCP_AGENT_SCOPE_REQUIRED')
      await expect(callLoad(ctx, current, ['p7_finance__quote'])).rejects.toThrow('P7_MCP_AGENT_SCOPE_REQUIRED')
      expect(store.active(current, () => true)).toEqual([])
    } finally { runtime.dispose(); await ctx.fiber.dispose() }
  })

  it('returns bounded no-match search and rejects guessed load IDs without changing the following selection', async () => {
    const current = agent('search')
    const ctx = await setup([current])
    const store = new ActivationStore<Agent>({ nameMapper: wireName => `p7_${wireName}` })
    store.publishCatalog([{ name: 'finance__quote', description: 'market quote', inputSchema: { type: 'object' } }])
    const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand' }))
    ctx.tools.register(businessTool('p7_finance__quote'), runtime.registrationOptions('p7_finance__quote'))
    try {
      await expect(callSearch(ctx, current, 'unrelated-no-match')).resolves.toMatchObject({ ok: true, status: 'no-match', tools: [] })
      await expect(callLoad(ctx, current, ['p7_not_in_catalog'])).resolves.toEqual({ ok: false, status: 'unknown' })
      const next = await resolve(ctx, current)
      expect(names(ctx, current, next)).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME])
      next.dispose()
    } finally { runtime.dispose(); await ctx.fiber.dispose() }
  })

  it('isolates a fixed child preset failure from another Agent during a catalog refresh', async () => {
    const fixed = agent('oversized-child')
    const normal = agent('normal-parent')
    const ctx = await setup([fixed, normal])
    const scope = await scopeFor(ctx, fixed)
    const store = new ActivationStore<Agent>({ nameMapper: name => `p7_${name}`, maxLoadedTools: 1 })
    const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand', maxLoadedTools: 1 }))
    const catalog = ['finance__quote', 'macro__gdp'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }))
    store.publishCatalog(catalog)
    for (const tool of catalog) ctx.tools.register(businessTool(`p7_${tool.name}`), runtime.registrationOptions(`p7_${tool.name}`))
    scope.ctx.tools.restrict({ allow: ['p7_finance__quote', 'p7_macro__gdp'] })
    try {
      expect(() => runtime.refresh()).not.toThrow()
      expect(runtime.errorFor(fixed)).toBe('P7_MCP_FIXED_PRESET_TOOL_LIMIT')
      expect(store.available).toBe(true)
      await expect(resolve(ctx, fixed)).rejects.toThrow()
      await callLoad(ctx, normal, ['p7_finance__quote'])
      const allowed = await resolve(ctx, normal)
      expect(names(ctx, normal, allowed)).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME, 'p7_finance__quote'].sort())
      allowed.dispose()
    } finally { runtime.dispose(); await scope.dispose(); await ctx.fiber.dispose() }
  })

  it('records a late fixed-child configuration error without failing the global lifecycle', async () => {
    const parent = agent('live-parent')
    const children = [parent]
    const ctx = await setup(children)
    const store = new ActivationStore<Agent>({ nameMapper: name => `p7_${name}`, maxLoadedTools: 1 })
    const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand', maxLoadedTools: 1 }))
    const catalog = ['finance__quote', 'macro__gdp'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }))
    store.publishCatalog(catalog)
    for (const tool of catalog) ctx.tools.register(businessTool(`p7_${tool.name}`), runtime.registrationOptions(`p7_${tool.name}`))
    const child = agent('late-child')
    children.push(child)
    const scope = await scopeFor(ctx, child)
    const removePolicy = scope.ctx.tools.restrict({ allow: ['p7_finance__quote', 'p7_macro__gdp'] })
    try {
      await expect(ctx.serial('agent/created', { agent: child, source: 'startup' })).resolves.toBeUndefined()
      expect(runtime.errorFor(child)).toBe('P7_MCP_FIXED_PRESET_TOOL_LIMIT')
      await expect(resolve(ctx, child)).rejects.toThrow()
      expect(store.available).toBe(true)
      const allowed = await resolve(ctx, parent)
      expect(names(ctx, parent, allowed)).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME])
      allowed.dispose()
      removePolicy()
      const recovered = await resolve(ctx, child)
      expect(runtime.errorFor(child)).toBeUndefined()
      expect(names(ctx, child, recovered)).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME])
      recovered.dispose()
    } finally { runtime.dispose(); await scope.dispose(); await ctx.fiber.dispose() }
  })

  it('keeps a 200-tool catalog out of the initial model context and admits only five on the next step', async () => {
    const current = agent('large-catalog')
    const ctx = await setup([current])
    const store = new ActivationStore<Agent>({ nameMapper: wireName => `p7_${wireName}` })
    const catalog = Array.from({ length: 200 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0')
      return {
        name: `finance__tool${number}`,
        description: `Synthetic finance catalog definition ${number}: ${'detail '.repeat(32)}`,
        inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: `parameter ${'detail '.repeat(12)}` } } },
      }
    })
    store.publishCatalog(catalog)
    const runtime = installLazyRuntime(ctx, store, resolveConfig({ mode: 'on-demand' }))
    for (const item of catalog) {
      const name = `p7_${item.name}`
      ctx.tools.register(businessTool(name, item.description), runtime.registrationOptions(name))
    }
    try {
      const eager = ctx.tools.schemas(current).filter(schema => store.owns(schema.name) || schema.name === SEARCH_TOOL_NAME || schema.name === LOAD_TOOL_NAME)
      expect(eager).toHaveLength(202)
      const initial = await resolve(ctx, current)
      const initialSchemas = ctx.tools.schemas(current, initial)
      expect(initialSchemas.map(schema => schema.name).sort()).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME])
      expect(initialSchemas.filter(schema => store.owns(schema.name))).toHaveLength(0)

      const selected = ['001', '040', '080', '120', '200'].map(number => `p7_finance__tool${number}`)
      await callLoad(ctx, current, selected)
      const loaded = await resolve(ctx, current)
      const loadedNames = names(ctx, current, loaded)
      expect(loadedNames).toEqual([LOAD_TOOL_NAME, SEARCH_TOOL_NAME, ...selected].sort())
      expect(loadedNames).not.toContain('p7_finance__tool002')
      expect(loadedNames).not.toContain('p7_finance__tool199')

      const eagerBytes = Buffer.byteLength(JSON.stringify(eager), 'utf8')
      const initialBytes = Buffer.byteLength(JSON.stringify(initialSchemas), 'utf8')
      expect(1 - initialBytes / eagerBytes).toBeGreaterThanOrEqual(0.8)
      initial.dispose(); loaded.dispose()
    } finally { runtime.dispose(); await ctx.fiber.dispose() }
  })
})
