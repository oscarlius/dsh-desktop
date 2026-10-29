// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { CompanyModelPicker, registerCompanyModelPicker } from '../src/client/CompanyModelPicker.js'
import { zh } from '../src/client/locales.js'

const provider = 'p7-company-responses'
const model = (id: string, efforts?: string[], defaultEffort = 'low') => ({ id, name: id,
  ...(efforts ? { reasoning: { defaultEffort, efforts: efforts.map(id => ({ id, name: id })) } } : {}),
})
const models = [model('Qwen', ['low', 'high']), model('Gemini', ['low', 'medium', 'high']),
  model('Codex', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'), model('MiniMax')]

function fixture(initial = 'Qwen', initialEffort?: string) {
  let state = { current: { provider, model: initial, ...(initialEffort ? { reasoningEffort: initialEffort } : {}) },
    groups: [{ id: provider, name: '公司模型', models }], failures: [], status: 'ready', pending: null, error: null, routable: true,
  } as unknown as ModelDirectoryState
  const listeners = new Set<() => void>()
  const update = (change: Partial<ModelDirectoryState>) => {
    state = { ...state, ...change }
    for (const listener of listeners) listener()
  }
  const directory = { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
  const select = vi.fn(async (selection: NonNullable<ModelDirectoryState['current']>) => {
    update({ current: selection })
    return { ok: true, value: undefined }
  })
  const props = { available: true, locked: false, directory, load: vi.fn(), select,
    t: (key: keyof typeof zh) => zh[key],
  } as unknown as Parameters<typeof CompanyModelPicker>[0]
  return { props, select, update, directory, current: () => state.current }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.getElementById('p7-company-model-picker-styles')?.remove() })

describe('company reasoning pill over the shared model directory', () => {
  it('offers only Qwen fast/deep and persists the exact high selection', async () => {
    const app = fixture()
    render(<CompanyModelPicker {...app.props} />)
    fireEvent.click(screen.getByRole('button', { name: '思考：快速' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    expect(screen.queryByText('标准')).toBeNull()
    expect(screen.queryByText('low')).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /深度/ }))
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'Qwen', reasoningEffort: 'high' }))
    expect(screen.getByRole('button', { name: '思考：深度' })).toBeTruthy()
    expect(app.current()?.reasoningEffort).toBe('high')
  })

  it('shows Gemini standard and sends medium through the same selection service', async () => {
    const app = fixture('Gemini')
    render(<CompanyModelPicker {...app.props} />)
    fireEvent.click(screen.getByRole('button', { name: '思考：快速' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    fireEvent.click(screen.getByRole('menuitem', { name: /标准/ }))
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'Gemini', reasoningEffort: 'medium' }))
  })

  it('supports advertised Codex xhigh/max and preserves a restored manual tier', async () => {
    const app = fixture('Codex', 'xhigh')
    const view = render(<CompanyModelPicker {...app.props} />)
    fireEvent.click(screen.getByRole('button', { name: '思考：极深' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(5)
    fireEvent.click(screen.getByRole('menuitem', { name: /最高/ }))
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'Codex', reasoningEffort: 'max' }))
    view.unmount()
    render(<CompanyModelPicker {...app.props} />)
    expect(screen.getByRole('button', { name: '思考：最高' })).toBeTruthy()
    expect(app.select).toHaveBeenCalledTimes(1)
  })

  it('clears inapplicable effort when switching models and defaults a supported company model to low', async () => {
    const app = fixture('Qwen', 'high')
    render(<CompanyModelPicker {...app.props} />)
    fireEvent.click(screen.getByRole('button', { name: '选择模型：Qwen' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'MiniMax' }))
    await waitFor(() => expect(app.select).toHaveBeenCalledWith({ provider, model: 'MiniMax' }))
    expect(screen.queryByRole('button', { name: /思考：/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '选择模型：MiniMax' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }))
    await waitFor(() => expect(app.select).toHaveBeenLastCalledWith({ provider, model: 'Codex', reasoningEffort: 'low' }))
    expect(screen.getByRole('button', { name: '思考：快速' })).toBeTruthy()
  })

  it('disables locked sessions and omits Agent-bound controls for addressed subagents', () => {
    const app = fixture()
    const view = render(<CompanyModelPicker {...app.props} locked />)
    expect((screen.getByRole('button', { name: '思考：快速' }) as HTMLButtonElement).disabled).toBe(true)
    view.rerender(<CompanyModelPicker {...app.props} available={false} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(app.select).not.toHaveBeenCalled()
  })

  it('keeps the valid selection and presents a rejected writer-held outcome', async () => {
    const app = fixture()
    app.select.mockImplementationOnce(async () => ({ ok: false, error: { code: 'session/writer-held' } }) as never)
    render(<CompanyModelPicker {...app.props} />)
    fireEvent.click(screen.getByRole('button', { name: '思考：快速' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /深度/ }))
    await waitFor(() => expect(screen.getByText('此会话正在其他窗口使用，请稍后重试。')).toBeTruthy())
    expect(app.current()?.reasoningEffort).toBeUndefined()
    expect(screen.getByRole('button', { name: '思考：快速' })).toBeTruthy()
  })

  it('uses the SDK menu keyboard dismissal and reflects catalog changes immediately', async () => {
    const app = fixture()
    render(<CompanyModelPicker {...app.props} />)
    const trigger = screen.getByRole('button', { name: '思考：快速' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
    expect(document.activeElement).toBe(trigger)
    act(() => app.update({ groups: [{ id: provider, name: '公司模型', models: [model('Qwen')] }] as never }))
    expect(screen.queryByRole('button', { name: /思考：/ })).toBeNull()
  })

  it('registers a company-only shadow entry and delegates to the existing session directory', async () => {
    const app = fixture()
    const shared = { store: app.directory, load: vi.fn(async () => undefined), select: app.select }
    const register = vi.fn()
    const scope = { modelDirectories: { directoryFor: vi.fn(() => shared) }, sessions: { subagentAddress: () => undefined },
      slots: { inject: (_name: string, mount: () => unknown) => mount(), register } }
    registerCompanyModelPicker({ effect: (fn: () => unknown) => fn(), inject: (_names: string[], mount: (scope: unknown) => void) => mount(scope) } as never)
    const [options] = register.mock.calls[0]!
    expect(options).toMatchObject({ name: 'conversation.input.model', priority: -100, locale: 'p7-company-models' })
    expect(options.children).toBeUndefined()
    const face = options.inject('session-1')
    expect(face.directory).toBe(app.directory)
    await face.select({ provider, model: 'Qwen', reasoningEffort: 'high' })
    expect(app.select).toHaveBeenCalledWith({ provider, model: 'Qwen', reasoningEffort: 'high' })
  })
})
