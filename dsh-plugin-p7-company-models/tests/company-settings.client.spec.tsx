// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompanyStatus } from '../src/public-status.js'
import { createCompanyModelsApi } from '../src/client/api.js'
import { CompanySettingsSection, type CompanySettingsSectionProps } from '../src/client/CompanySettingsSection.js'
import { CompanyLoginGate } from '../src/client/CompanyLoginGate.js'
import { apply, NS } from '../src/client/index.js'
import { en, type CompanySettingsLocaleKey } from '../src/client/locales.js'
import { installCompanySettingsStyles } from '../src/client/company-settings-styles.js'

const READY: CompanyStatus = {
  loginRequired: false,
  phase: 'ready', origin: 'https://models.example.com', revision: 'r7', lastSyncedAt: 1_700_000_000_000,
  defaultModel: 'p7-default', models: [{ id: 'p7-default', displayName: 'P7 Default' }], message: null,
  tools: { phase: 'registered', tools: [{ name: 'mcp__p7__gildata__FinQuery' }, { name: 'mcp__p7__search__web_search' }] },
}
const ACCOUNT_PROFILE = { userId: 'u1', organizationId: 'o1', displayName: 'Ada', role: 'employee', deviceId: 'd1', sessionId: 's1', scopes: [] }
const SIGNED_IN = { phase: 'signed-in' as const, profile: ACCOUNT_PROFILE, expiresAt: Date.now() + 60_000, authorizationUrl: null, upgradeUrl: null, message: null }
const PENDING = { phase: 'pending' as const, profile: null, expiresAt: null, authorizationUrl: 'https://identity.example/login', upgradeUrl: null, message: null }
const SIGNED_OUT = { phase: 'signed-out' as const, profile: null, expiresAt: null, authorizationUrl: null, upgradeUrl: null, message: null }
const USAGE = { from: '2026-10-01T00:00:00+08:00', to: '2026-10-21T00:00:00.000Z', timeZone: 'Asia/Shanghai', totals: { requests: 3, inputTokens: 1, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, searchCalls: 0, mcpCalls: 0, costMicrounits: null, currency: null }, unknownRequestCount: 0, partialRequestCount: 0, unattributedLegacyRequestCount: 0, items: [] }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const t = (key: CompanySettingsLocaleKey): string => en[key]

afterEach(() => { cleanup(); vi.restoreAllMocks(); globalThis.__DSH_COMPANY_POLICY__ = undefined; document.getElementById('dsh-p7-company-models-settings-styles')?.remove() })

describe('P7 company-model settings API', () => {
  it('uses only same-origin endpoints and does not turn an error body into a user message', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).endsWith('/status') ? json(READY) : json(READY))
    const api = createCompanyModelsApi(fetcher)
    await expect(api.status()).resolves.toEqual(READY)
    await expect(api.connect({ origin: 'https://models.example.com', apiKey: 'secret' })).resolves.toEqual(READY)
    await expect(api.sync()).resolves.toEqual(READY)
    await expect(api.disconnect()).resolves.toEqual(READY)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/p7-company-models/status', '/p7-company-models/connect', '/p7-company-models/sync', '/p7-company-models/disconnect',
    ])
    const calls = fetcher.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][]
    expect(calls[1]?.[1]).toMatchObject({
      method: 'POST', credentials: 'same-origin', redirect: 'error', body: JSON.stringify({ origin: 'https://models.example.com', apiKey: 'secret' }),
    })
    expect(calls[2]?.[1]).toMatchObject({ body: JSON.stringify({}) })
    const failing = createCompanyModelsApi(async () => json({ error: 'secret server detail' }, 500))
    await expect(failing.status()).rejects.toThrow('P7 company models request failed (500)')
    await expect(failing.status()).rejects.not.toThrow('secret server detail')
  })
})

describe('P7 company-model settings registration', () => {
  it('registers zh/en copy and a settings.section surface', () => {
    const register = vi.fn(() => () => {})
    const inject = vi.fn((_slot: string, mount: () => unknown) => mount())
    const localeRegister = vi.fn(() => () => {})
    const ctx = {
      locale: { bind: (namespace: string) => (key: string) => `${namespace}:${key}`, register: localeRegister },
      effect: vi.fn((effect: () => unknown) => effect()),
      slots: { inject, register },
    }
    apply(ctx as never)
    expect(localeRegister).toHaveBeenCalledWith(NS, expect.objectContaining({ en, zh: expect.any(Object) }))
    expect(inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(inject).toHaveBeenCalledWith('shell.overlay', expect.any(Function))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.section', id: 'p7-company-models', order: 60, locale: NS,
    }), CompanySettingsSection)
  })

  it('injects the scoped settings style from the bundled client code', () => {
    document.getElementById('dsh-p7-company-models-settings-styles')?.remove()
    const dispose = installCompanySettingsStyles()
    const style = document.getElementById('dsh-p7-company-models-settings-styles')
    expect(style?.dataset.pluginCss).toBe('dsh-plugin-p7-company-models/settings')
    expect(style?.textContent).toContain('.dshP7CompanySettingsInput')
    expect(style?.textContent).toContain('@media (max-width: 640px)')
    dispose()
    expect(document.getElementById('dsh-p7-company-models-settings-styles')).toBeNull()
  })
})

describe('P7 company login shell gate', () => {
  it('blocks the shell before Host status returns when the company policy requires personal login', () => {
    globalThis.__DSH_COMPANY_POLICY__ = { requirePersonalLogin: true }
    const api = { status: vi.fn(() => new Promise<CompanyStatus>(() => {})), accountStatus: vi.fn(() => new Promise<typeof SIGNED_OUT>(() => {})), accountLogin: vi.fn() }
    render(<CompanyLoginGate {...({ api, t } as unknown as import('../src/client/CompanyLoginGate.js').CompanyLoginGateProps)} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Sign in to your company Feishu account')).toBeTruthy()
  })

  it('keeps the policy gate when an older Host status omits loginRequired', async () => {
    globalThis.__DSH_COMPANY_POLICY__ = { requirePersonalLogin: true }
    const api = {
      status: vi.fn(async () => ({ ...READY, loginRequired: undefined } as unknown as CompanyStatus)), accountStatus: vi.fn(async () => SIGNED_OUT), accountLogin: vi.fn(),
    }
    render(<CompanyLoginGate {...({ api, t } as unknown as import('../src/client/CompanyLoginGate.js').CompanyLoginGateProps)} />)
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('focuses and traps keyboard navigation inside the login gate', async () => {
    globalThis.__DSH_COMPANY_POLICY__ = { requirePersonalLogin: true }
    const underlying = document.createElement('button')
    let underlyingKeys = 0
    underlying.addEventListener('keydown', () => { underlyingKeys++ })
    document.body.append(underlying)
    const api = { status: vi.fn(() => new Promise<CompanyStatus>(() => {})), accountStatus: vi.fn(() => new Promise<typeof SIGNED_OUT>(() => {})), accountLogin: vi.fn() }
    try {
      render(<CompanyLoginGate {...({ api, t } as unknown as import('../src/client/CompanyLoginGate.js').CompanyLoginGateProps)} />)
      const signIn = await screen.findByRole('button', { name: 'Sign in to company account' })
      const refresh = screen.getByRole('button', { name: 'Refresh sign-in status' })
      await waitFor(() => expect(document.activeElement).toBe(signIn))
      fireEvent.keyDown(signIn, { key: 'Tab' })
      expect(document.activeElement).toBe(refresh)
      fireEvent.keyDown(refresh, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(signIn)
      fireEvent.keyDown(underlying, { key: 'Enter' })
      expect(underlyingKeys).toBe(0)
      expect(document.activeElement).toBe(signIn)
      fireEvent.keyDown(signIn, { key: 'Escape' })
      expect(screen.getByRole('dialog')).toBeTruthy()
    } finally { underlying.remove() }
  })
  it('keeps the policy gate blocking when the Host status request fails', async () => {
    globalThis.__DSH_COMPANY_POLICY__ = { requirePersonalLogin: true }
    const api = {
      status: vi.fn(async () => { throw new Error('offline') }), accountStatus: vi.fn(async () => { throw new Error('offline') }), accountLogin: vi.fn(),
    }
    render(<CompanyLoginGate {...({ api, t } as unknown as import('../src/client/CompanyLoginGate.js').CompanyLoginGateProps)} />)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('temporarily unavailable')
  })
  it('uses the Host loginRequired status and removes the overlay only after sign-in', async () => {
    const api = {
      status: vi.fn(async () => ({ ...READY, loginRequired: true })), accountStatus: vi.fn(async () => SIGNED_OUT), accountLogin: vi.fn(async () => SIGNED_IN),
    }
    render(<CompanyLoginGate {...({ api, t } as unknown as import('../src/client/CompanyLoginGate.js').CompanyLoginGateProps)} />)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to company account' }))
    await waitFor(() => expect(api.accountLogin).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('P7 company-model settings section', () => {
  it('shows the safe host recovery message so a failed connection is actionable', async () => {
    const status: CompanyStatus = { ...READY, phase: 'error', message: 'Reconnect P7 to repair the saved configuration.' }
    const api = createCompanyModelsApi(async () => json(status))
    render(<CompanySettingsSection {...({ api, t } as CompanySettingsSectionProps)} />)
    expect((await screen.findByRole('status')).textContent).toBe(status.message)
  })

  it('connects with the entered key, clears it after completion, and presents the delivered catalog as read-only', async () => {
    const api = {
      status: vi.fn(async () => ({ ...READY, phase: 'disconnected' as const, origin: null, revision: null, lastSyncedAt: null, defaultModel: null, models: [] })),
      connect: vi.fn(async () => READY), sync: vi.fn(async () => READY), disconnect: vi.fn(async () => ({ ...READY, phase: 'disconnected' as const, origin: null, revision: null, lastSyncedAt: null, defaultModel: null, models: [] })),
    }
    const props = { api, t } as unknown as CompanySettingsSectionProps
    const view = render(<CompanySettingsSection {...props} />)
    await screen.findByText('Disconnected')
    expect(screen.getByText('https://maas.zxrc.com.cn:8090')).toBeTruthy()
    expect(screen.queryByLabelText('Service URL')).toBeNull()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'only-for-this-request' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith({ origin: 'https://maas.zxrc.com.cn:8090', apiKey: 'only-for-this-request' }, expect.any(AbortSignal)))
    await screen.findByText('P7 Default')
    expect(view.container.querySelector('.dshP7CompanySettingsModel')).toBeTruthy()
    expect(view.container.querySelector('.dshP7CompanySettingsDefinitionGrid')).toBeTruthy()
    expect(screen.queryByDisplayValue('only-for-this-request')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'P7 Default' })).toBeNull()
    expect(screen.getByText('r7')).toBeTruthy()
  })

  it('shows Host-registered MCP/search tools without claiming that this conversation used them', async () => {
    const api = {
      status: vi.fn(async () => READY), connect: vi.fn(), sync: vi.fn(), disconnect: vi.fn(),
      accountStatus: vi.fn(async () => SIGNED_IN), accountLogin: vi.fn(async () => PENDING), accountLogout: vi.fn(async () => SIGNED_OUT), accountUsage: vi.fn(async () => USAGE),
    }
    render(<CompanySettingsSection {...({ api, t } as unknown as CompanySettingsSectionProps)} />)
    expect(await screen.findByText('Gildata financial data query')).toBeTruthy()
    expect(screen.getByText('Web search')).toBeTruthy()
    expect(screen.getByText('mcp__p7__gildata__FinQuery')).toBeTruthy()
    expect(screen.getByText('mcp__p7__search__web_search')).toBeTruthy()
    expect(screen.getByText('Registered')).toBeTruthy()
    expect(screen.getByText(/may not call one every turn/)).toBeTruthy()
  })

  it('lets the user cancel the current key input and aborts a pending request on unmount', async () => {
    let abort: AbortSignal | undefined
    const api = {
      status: vi.fn(async () => ({ ...READY, phase: 'disconnected' as const, origin: null, revision: null, lastSyncedAt: null, defaultModel: null, models: [] })),
      connect: vi.fn((_input: unknown, signal?: AbortSignal) => new Promise<CompanyStatus>((_resolve, reject) => {
        abort = signal
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })),
      sync: vi.fn(async () => READY), disconnect: vi.fn(async () => READY),
    }
    const props = { api, t } as unknown as CompanySettingsSectionProps
    const view = render(<CompanySettingsSection {...props} />)
    await screen.findByText('Disconnected')
    fireEvent.click(screen.getByRole('button', { name: 'Change service address' }))
    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'https://models.example.com' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'temporary-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this input' }))
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'temporary-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(abort).toBeDefined())
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
    view.unmount()
    expect(abort?.aborted).toBe(true)
  })

  it('allows reconnecting while an older status request has not settled', async () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      let oldStatusSignal: AbortSignal | undefined
      const api = {
        status: vi.fn((signal?: AbortSignal) => {
          reads++
          if (reads === 1) return Promise.resolve(READY)
          oldStatusSignal = signal
          return new Promise<CompanyStatus>(() => {})
        }),
        connect: vi.fn(async () => READY), sync: vi.fn(async () => READY), disconnect: vi.fn(async () => READY),
      }
      const props = { api, t } as unknown as CompanySettingsSectionProps
      render(<CompanySettingsSection {...props} />)
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(screen.getByText('P7 Default')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(oldStatusSignal).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
      expect(oldStatusSignal?.aborted).toBe(true)
      fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'new-key' } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      expect(api.connect).toHaveBeenCalledWith({ origin: 'https://models.example.com', apiKey: 'new-key' }, expect.any(AbortSignal))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not allow an earlier response to overwrite a newer unmounted view', async () => {
    let resolve!: (status: CompanyStatus) => void
    const api = {
      status: vi.fn(() => new Promise<CompanyStatus>(done => { resolve = done })),
      connect: vi.fn(async () => READY), sync: vi.fn(async () => READY), disconnect: vi.fn(async () => READY),
    }
    const props = { api, t } as unknown as CompanySettingsSectionProps
    const view = render(<CompanySettingsSection {...props} />)
    view.unmount()
    await act(async () => { resolve(READY) })
    expect(document.body.textContent).not.toContain('P7 Default')
  })

  it('polls a pending browser login to completion and requests usage once with a Shanghai month boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
    try {
      const api = {
        status: vi.fn(async () => READY), connect: vi.fn(), sync: vi.fn(), disconnect: vi.fn(),
        accountStatus: vi.fn().mockResolvedValueOnce(PENDING).mockResolvedValue(SIGNED_IN),
        accountLogin: vi.fn(async () => PENDING), accountLogout: vi.fn(async () => SIGNED_OUT), accountUsage: vi.fn(async () => USAGE),
      }
      render(<CompanySettingsSection {...({ api, t } as unknown as CompanySettingsSectionProps)} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText('Sign-in pending')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(screen.getByText('Signed in')).toBeTruthy()
      expect(api.accountUsage).toHaveBeenCalledTimes(1)
      expect(api.accountUsage).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-01T00:00:00+08:00', groupBy: 'service' }), expect.any(AbortSignal))
    } finally { vi.useRealTimers() }
  })

  it('refreshes account status with company polling without repeatedly querying signed-in usage', async () => {
    vi.useFakeTimers()
    try {
      const api = {
        status: vi.fn(async () => READY), connect: vi.fn(), sync: vi.fn(), disconnect: vi.fn(),
        accountStatus: vi.fn(async () => SIGNED_IN), accountLogin: vi.fn(async () => PENDING), accountLogout: vi.fn(async () => SIGNED_OUT), accountUsage: vi.fn(async () => USAGE),
      }
      render(<CompanySettingsSection {...({ api, t } as unknown as CompanySettingsSectionProps)} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(api.accountUsage).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(api.accountStatus.mock.calls.length).toBeGreaterThan(1)
      expect(api.accountUsage).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('does not apply a late usage response after logout', async () => {
    let completeUsage!: (value: typeof USAGE) => void
    const api = {
      status: vi.fn(async () => READY), connect: vi.fn(), sync: vi.fn(), disconnect: vi.fn(),
      accountStatus: vi.fn(async () => SIGNED_IN), accountLogin: vi.fn(async () => PENDING), accountLogout: vi.fn(async () => SIGNED_OUT),
      accountUsage: vi.fn(async () => await new Promise<typeof USAGE>(resolve => { completeUsage = resolve })),
    }
    render(<CompanySettingsSection {...({ api, t } as unknown as CompanySettingsSectionProps)} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(completeUsage).toBeTypeOf('function')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    completeUsage(USAGE)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Signed out')).toBeTruthy()
    expect(screen.queryByText('3')).toBeNull()
  })
})
