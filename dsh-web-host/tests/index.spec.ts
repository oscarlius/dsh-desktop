import { expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

it('keeps workspace route admission separate from the company account origin', async () => {
  const provided = new Map<string, unknown>()
  const context = {
    p7WebTrustedSession: { isTrustedRequest: () => true },
    webServer: { register: () => () => {} },
    agents: { list: () => [] },
    connection: { authenticatedUrl: (baseUrl: string) => `${baseUrl}?token=synthetic` },
    workspaceRegistry: { initializeDefault: vi.fn(async () => undefined) },
    provide: vi.fn((name: string, value: unknown) => provided.set(name, value)),
    inject: vi.fn(),
    on: vi.fn(),
    effect: vi.fn((effect: () => unknown) => effect()),
  }

  await apply(context as never, {
    publicOrigin: 'https://maas.zxrc.com.cn:8092',
    companyOrigin: 'https://maas.zxrc.com.cn:8090',
  })

  const factory = provided.get('p7AccountFactory') as { create(): { connection(): { origin: string } } }
  const admission = provided.get('p7CompanyRouteAdmission') as { publicOrigin(): string }
  expect(context.workspaceRegistry.initializeDefault).toHaveBeenCalledOnce()
  expect(factory.create().connection().origin).toBe('https://maas.zxrc.com.cn:8090')
  expect(admission.publicOrigin()).toBe('https://maas.zxrc.com.cn:8092')
})
