// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { CompanyModelPicker, registerCompanyModelPicker } from '../src/client/CompanyModelPicker.js'
import { zh } from '../src/client/locales.js'
import { apply, inject as clientInject } from '../src/client/index.js'

const provider = 'p7-company-responses'
const model = (id: string, efforts?: string[], defaultEffort = 'low') => ({ id, name: id, ...(efforts ? { reasoning: { defaultEffort, efforts: efforts.map(id => ({ id, name: id })) } } : {}) })
const models = [model('Qwen', ['low', 'high']), model('Gemini', ['low', 'medium', 'high']), model('Codex', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'), model('MiniMax')]
function fixture(initial = 'Qwen', initialEffort?: string) {
  let state = { current: { provider, model: initial, ...(initialEffort ? { reasoningEffort: initialEffort } : {}) }, groups: [{ id: provider, name: '公司模型', models }], failures: [], status: 'ready', pending: null, error: null, routable: true } as unknown as ModelDirectoryState
  const listeners = new Set<() => void>()
  const update = (change: Partial<ModelDirectoryState>) => { state = { ...state, ...change }; listeners.forEach(listener => listener()) }
  const directory = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
  const select = vi.fn(async (selection: NonNullable<ModelDirectoryState['current']>) => { update({ current: selection }); return { ok: true, value: undefined } })
  const props = { available: true, locked: false, directory, load: vi.fn(), select, t: (key: keyof typeof zh) => zh[key] } as unknown as Parameters<typeof CompanyModelPicker>[0]
  return { props, select, directory, current: () => state.current, update }
}
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function openSlider() { fireEvent.click(screen.getByRole('button', { name: /推理强度：/ })); return screen.getByRole('slider', { name: '推理强度' }) as HTMLInputElement }

/** Matches the caller-traced `remote.session` access used by the client RPC namespace. */
class RemoteNamespace extends Service {
  constructor(ctx: Context, private readonly sessionWire: unknown) { super(ctx, 'remote') }
  get session() { return this.ctx.get('remote.session') }
  $on() { return this.sessionWire }
}

describe('company reasoning slider', () => {
  it('migrates an unroutable P7 alias to its one routable P7 protocol group', async () => {
    const app = fixture('GPT6.1-SOL', 'high')
    app.update({ current: { provider: 'p7-company-chat', model: 'GPT6.1-SOL', reasoningEffort: 'high' }, routable: false, groups: [
      { id: 'p7-company-chat', name: 'Chat', models: [model('old3')] },
      { id: provider, name: 'Responses', models: [model('GPT6.1-SOL', ['low', 'high'])] },
    ] })
    render(<CompanyModelPicker {...app.props} />)
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'GPT6.1-SOL', reasoningEffort: 'high' }))
    expect(app.current()).toEqual({ provider, model: 'GPT6.1-SOL', reasoningEffort: 'high' })
  })
  it('uses the target model default when the saved effort is unsupported', async () => {
    const app = fixture('GPT6.1-SOL', 'high')
    app.update({ current: { provider: 'p7-company-chat', model: 'GPT6.1-SOL', reasoningEffort: 'high' }, routable: false, groups: [
      { id: 'p7-company-chat', name: 'Chat', models: [model('old3')] },
      { id: provider, name: 'Responses', models: [model('GPT6.1-SOL', ['low'])] },
    ] })
    render(<CompanyModelPicker {...app.props} />)
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'GPT6.1-SOL', reasoningEffort: 'low' }))
  })
  it.each([
    ['a routable current selection', { routable: true }],
    ['a local selection', { current: { provider: 'local', model: 'GPT6.1-SOL' }, routable: false }],
    ['an unavailable directory', { available: false, routable: false }],
    ['a loading directory', { status: 'loading', routable: false }],
    ['an ambiguous same-alias P7 target', { routable: false, groups: [
      { id: 'p7-company-chat', name: 'Chat', models: [model('old3')] },
      { id: 'p7-company-responses', name: 'Responses', models: [model('GPT6.1-SOL')] },
      { id: 'p7-company-messages', name: 'Messages', models: [model('GPT6.1-SOL')] },
    ] }],
    ['a locked session', { locked: true, routable: false }],
  ])('does not auto-migrate %s', async (_name, change) => {
    const app = fixture('GPT6.1-SOL')
    app.update(Object.assign({ current: { provider: 'p7-company-chat', model: 'GPT6.1-SOL' }, routable: false, groups: [
      { id: 'p7-company-chat', name: 'Chat', models: [model('old3')] },
      { id: provider, name: 'Responses', models: [model('GPT6.1-SOL')] },
    ] }, change) as Partial<ModelDirectoryState>)
    render(<CompanyModelPicker {...app.props} {...(change as { available?: boolean, locked?: boolean })} />)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(app.select).not.toHaveBeenCalled()
  })
  it('does not retry a failed automatic migration and exposes its error', async () => {
    const app = fixture('GPT6.1-SOL')
    app.select.mockResolvedValue({ ok: false, error: { code: 'selection/rejected' } } as never)
    app.update({ current: { provider: 'p7-company-chat', model: 'GPT6.1-SOL' }, routable: false, groups: [
      { id: 'p7-company-chat', name: 'Chat', models: [model('old3')] },
      { id: provider, name: 'Responses', models: [model('GPT6.1-SOL')] },
    ] })
    render(<CompanyModelPicker {...app.props} />)
    await waitFor(() => expect(screen.getByText('切换未成功，请重试。')).toBeTruthy())
    expect(app.select).toHaveBeenCalledTimes(1)
  })
  it('uses Qwen metadata only and commits a drag once on release', async () => {
    const app = fixture(); render(<CompanyModelPicker {...app.props} />); const range = openSlider()
    expect(range.max).toBe('1'); fireEvent.change(range, { target: { value: '1' } }); expect(app.select).not.toHaveBeenCalled(); fireEvent.pointerUp(range)
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'Qwen', reasoningEffort: 'high' })); expect(app.select).toHaveBeenCalledTimes(1); expect(screen.getByRole('dialog', { name: '推理强度' })).toBeTruthy()
  })
  it('uses native slider keyboard selection without menu focus movement', async () => {
    const app = fixture('Gemini'); render(<CompanyModelPicker {...app.props} />); const range = openSlider(); range.focus()
    fireEvent.keyDown(range, { key: 'ArrowRight' }); fireEvent.change(range, { target: { value: '1' } }); fireEvent.keyUp(range, { key: 'ArrowRight' })
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'Gemini', reasoningEffort: 'medium' })); expect(document.activeElement).toBe(range)
  })
  it('supports model-specific Codex tier counts', () => {
    const app = fixture('Codex', 'xhigh'); render(<CompanyModelPicker {...app.props} />); expect(openSlider().max).toBe('4')
  })
  it('resets to the model default and keeps the popup open', async () => {
    const app = fixture('Codex', 'max'); render(<CompanyModelPicker {...app.props} />); openSlider(); fireEvent.click(screen.getByRole('button', { name: '恢复默认推理强度' }))
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'Codex', reasoningEffort: 'low' })); expect(screen.getByRole('dialog', { name: '推理强度' })).toBeTruthy()
  })
  it('starts a supported company model at low when changing models', async () => {
    const app = fixture('Qwen', 'high'); render(<CompanyModelPicker {...app.props} />); fireEvent.click(screen.getByRole('button', { name: '选择模型：Qwen' })); fireEvent.click(screen.getByRole('menuitem', { name: 'MiniMax' }))
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'MiniMax' })); expect(screen.queryByRole('button', { name: /推理强度：/ })).toBeNull()
  })
  it('reverts preview and preserves the durable value after writer-held rejection', async () => {
    const app = fixture(); app.select.mockImplementationOnce(async () => ({ ok: false, error: { code: 'session/writer-held' } }) as never); render(<CompanyModelPicker {...app.props} />); const range = openSlider(); fireEvent.change(range, { target: { value: '1' } }); fireEvent.pointerUp(range)
    await waitFor(() => expect(screen.getByText('此会话正在其他窗口使用，请稍后重试。')).toBeTruthy()); expect(app.current()?.reasoningEffort).toBeUndefined(); expect(screen.getByRole('button', { name: '推理强度：低' })).toBeTruthy()
  })
  it('does not commit Escape and disables controls when locked', async () => {
    const app = fixture(); const view = render(<CompanyModelPicker {...app.props} />); const trigger = screen.getByRole('button', { name: '推理强度：低' }); fireEvent.click(trigger); const range = screen.getByRole('slider'); fireEvent.keyDown(range, { key: 'Escape' }); fireEvent.keyUp(range, { key: 'Escape' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false')); expect(app.select).not.toHaveBeenCalled(); fireEvent.click(trigger); view.rerender(<CompanyModelPicker {...app.props} locked />); expect((trigger as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true)
  })
  it('registers the company shadow entry over the shared directory', async () => {
    const app = fixture(); const shared = { store: app.directory, load: vi.fn(async () => undefined), select: app.select }; const register = vi.fn(); const scope = { modelDirectories: { directoryFor: vi.fn(() => shared) }, sessions: { subagentAddress: () => undefined }, slots: { inject: (_name: string, mount: () => unknown) => mount(), register } }
    registerCompanyModelPicker({ effect: (fn: () => unknown) => fn(), inject: (_names: string[], mount: (scope: unknown) => void) => mount(scope) } as never); const [options] = register.mock.calls[0]!; expect(options).toMatchObject({ name: 'conversation.input.model', priority: -100 }); const face = options.inject('session-1'); await face.select({ provider, model: 'Qwen', reasoningEffort: 'high' }); expect(app.select).toHaveBeenCalledWith({ provider, model: 'Qwen', reasoningEffort: 'high' })
  })
  it('mounts the shadow entry through the real Cordis capability boundary', async () => {
    const serviceUrl = pathToFileURL(resolve(process.cwd(), '../deepseek-harness/packages/client/ui-model-selection/src/client/service.ts'))
    const { ModelDirectoryResolver } = await import(/* @vite-ignore */ serviceUrl.href) as { ModelDirectoryResolver: new (ctx: Context) => Service }
    const ctx = new Context(); const register = vi.fn(() => () => {})
    const scopes = new Map<string, Context>(); const projection = { getSnapshot: () => ({ lastUsed: null, next: { provider, model: 'Qwen' } }), subscribe: () => () => {} }; const bindings = new Map<string, { session: { projections: { faceOf: () => typeof projection }, getSnapshot: () => { blank: boolean } } }>()
    const sessionWire = { modelCatalog: vi.fn(async () => ({ ok: true, value: { default: { provider, model: 'Qwen' }, routableProviders: [provider], groups: [{ id: provider, name: 'Company', models: [models[0]] }], failures: [] } })), selectModel: vi.fn(async () => ({ ok: true, value: undefined })) }
    ctx.provide('locale', { bind: () => (key: keyof typeof zh) => zh[key], register: vi.fn(() => () => {}) })
    ctx.provide('slots', { inject: (_name: string, mount: () => unknown) => mount(), register, entriesOfSlot: () => [], subscribe: () => () => {} })
    ctx.provide('sessions', { subagentAddress: () => undefined, scope: (id: string) => scopes.get(id), binding: (id: string) => bindings.get(id) })
    await ctx.plugin(providerCtx => {
      new RemoteNamespace(providerCtx, sessionWire)
      providerCtx.reflect.provide('remote.session', sessionWire)
    }).await()
    const resolver = ctx.plugin(ModelDirectoryResolver); await resolver.await()
    const sessionId = 'real-session' as never
    scopes.set(sessionId, ctx.extend())
    bindings.set(sessionId, { session: { projections: { faceOf: () => projection }, getSnapshot: () => ({ blank: false }) } })
    const fiber = ctx.plugin({ inject: clientInject, apply })
    await fiber.await()
    const options = (register.mock.calls as unknown as [Record<string, unknown>, unknown][]).find(([candidate]) => candidate.name === 'conversation.input.model')?.[0] as { priority: number, inject: (id: typeof sessionId) => { directory: { getSnapshot: () => ModelDirectoryState } } } | undefined
    expect(options).toMatchObject({ priority: -100 })
    expect(options?.inject(sessionId).directory.getSnapshot().current).toMatchObject({ provider, model: 'Qwen' })
    await ctx.fiber.dispose()
  })
})
