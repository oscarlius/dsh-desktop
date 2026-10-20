// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompanyStatus } from '../src/public-status.js'
import { createCompanyModelsApi } from '../src/client/api.js'
import { CompanySettingsSection, type CompanySettingsSectionProps } from '../src/client/CompanySettingsSection.js'
import { apply, NS } from '../src/client/index.js'
import { en, type CompanySettingsLocaleKey } from '../src/client/locales.js'

const READY: CompanyStatus = {
  phase: 'ready', origin: 'https://models.example.com', revision: 'r7', lastSyncedAt: 1_700_000_000_000,
  defaultModel: 'p7-default', models: [{ id: 'p7-default', displayName: 'P7 Default' }], message: null,
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const t = (key: CompanySettingsLocaleKey): string => en[key]

afterEach(() => { cleanup(); vi.restoreAllMocks() })

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
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.section', id: 'p7-company-models', order: 60, locale: NS,
    }), CompanySettingsSection)
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
    render(<CompanySettingsSection {...props} />)
    await screen.findByText('Disconnected')
    fireEvent.change(screen.getByLabelText('Service URL'), { target: { value: 'https://models.example.com' } })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'only-for-this-request' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith({ origin: 'https://models.example.com', apiKey: 'only-for-this-request' }, expect.any(AbortSignal)))
    await screen.findByText('P7 Default')
    expect(screen.queryByDisplayValue('only-for-this-request')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'P7 Default' })).toBeNull()
    expect(screen.getByText('r7')).toBeTruthy()
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
})
