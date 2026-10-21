import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import { API_PATHS } from '../src/http-contract.js'
import { CompanyHost } from '../src/company-host.js'

describe('published Cordis entrypoint', () => {
  it('activates the settings endpoints and releases all routes on plugin disposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'p7-plugin-'))
    const ctx = new Context()
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    ctx.provide('loader', { await: () => settled } as never)
    const initialize = vi.spyOn(CompanyHost.prototype, 'initialize').mockResolvedValue()
    const paths = new Set<string>()
    const register = vi.fn((route: { path: string }) => { paths.add(route.path); return () => { paths.delete(route.path) } })
    ctx.provide('webServer', { register, getOrigin: () => 'http://127.0.0.1:3000' } as never)
    ctx.provide('profileContext', { dir } as never)
    ctx.provide('settings', { describe: () => [], mutate: vi.fn() } as never)
    ctx.provide('credentials', { resolve: vi.fn(), set: vi.fn(), unset: vi.fn() } as never)
    ctx.provide('llm', { listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', settingsPath: ['providers'] }] } as never)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'local', model: 'local-model' }), saveSelection: vi.fn() } as never)
    try {
      await ctx.plugin(plugin)
      expect(paths).toEqual(new Set(Object.values(API_PATHS)))
      expect(initialize).not.toHaveBeenCalled()
      settle()
      await vi.waitFor(() => { expect(initialize).toHaveBeenCalledOnce() })
      await ctx.fiber.dispose()
      expect(paths.size).toBe(0)
    } finally {
      settle()
      await ctx.fiber.dispose()
      initialize.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
