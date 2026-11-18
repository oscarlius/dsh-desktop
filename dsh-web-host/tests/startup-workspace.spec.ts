import { expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

it('does not publish services or routes until initialization settles successfully', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const context = {
    p7WebTrustedSession: { isTrustedRequest: () => true },
    connection: { authenticatedUrl: (url: string) => url },
    workspaceRegistry: { initializeDefault: vi.fn(() => pending) },
    provide: vi.fn(), inject: vi.fn(), on: vi.fn(), effect: vi.fn(),
  }
  const start = () => apply(context as never, { publicOrigin: 'https://workspace.example' })
  const running = start()
  expect(context.provide).not.toHaveBeenCalled()
  expect(context.effect).not.toHaveBeenCalled()
  finish()
  await running
  expect(context.provide).toHaveBeenCalled()
  expect(context.effect).toHaveBeenCalled()

  context.provide.mockClear()
  context.effect.mockClear()
  context.workspaceRegistry.initializeDefault.mockImplementationOnce(async () => { throw new Error('initialization failed') })
  await expect(start()).rejects.toThrow('initialization failed')
  expect(context.provide).not.toHaveBeenCalled()
  expect(context.effect).not.toHaveBeenCalled()
})
