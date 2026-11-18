import { afterEach, expect, it, vi } from 'vitest'
import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { initializeCompanyWorkspace } from '../src/default-workspace.js'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../deepseek-harness/packages/storage/storage-domain/tests/helpers/memory-backend.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-workspace-'))
  roots.push(base)
  const parent = join(base, 'workspace')
  await mkdir(parent)
  const target = join(parent, '投研工作')
  const initializeDefault = vi.fn(async (resolve: () => Promise<string>) => resolve())
  return { base, parent, target, initializeDefault }
}

it('persists the official registry identity, reuses it on restart and does not recreate it after deletion', async () => {
  const { parent, target } = await fixture()
  const pool = new MemoryMediaPool()
  async function boot() {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    ctx.provide('sessions', { list: () => [] } as never)
    await ctx.plugin(WorkspaceRegistry)
    return ctx
  }
  const first = await boot()
  const created = await initializeCompanyWorkspace(first.workspaceRegistry, parent)
  expect(created?.path).toBe(target)
  expect(first.workspaceRegistry.list()).toHaveLength(1)
  await first.fiber.dispose()
  const second = await boot()
  expect((await initializeCompanyWorkspace(second.workspaceRegistry, parent))?.id).toBe(created?.id)
  await second.workspaceRegistry.delete(created!.id)
  await second.fiber.dispose()
  const third = await boot()
  expect(await initializeCompanyWorkspace(third.workspaceRegistry, parent)).toBeUndefined()
  expect(third.workspaceRegistry.list()).toHaveLength(0)
  expect((await lstat(target)).isDirectory()).toBe(true)
  await third.fiber.dispose()
})

it('passes an existing directory unchanged to the official initializer', async () => {
  const { parent, target, initializeDefault } = await fixture()
  await mkdir(target)
  await writeFile(join(target, 'data.txt'), 'preserve')
  await expect(initializeCompanyWorkspace({ initializeDefault }, parent)).resolves.toBe(target)
  expect(await readFile(join(target, 'data.txt'), 'utf8')).toBe('preserve')
  expect(initializeDefault).toHaveBeenCalledTimes(1)
})

it('allows the official initializer to create the absent target', async () => {
  const { parent, target, initializeDefault } = await fixture()
  await expect(initializeCompanyWorkspace({ initializeDefault }, parent)).resolves.toBe(target)
  expect(initializeDefault).toHaveBeenCalledTimes(1)
})

it.each(['file', 'link', 'dangling-link'] as const)('rejects a %s at target without touching its contents', async kind => {
  const { base, parent, target, initializeDefault } = await fixture()
  if (kind === 'file') await writeFile(target, 'preserve')
  else {
    const destination = join(base, kind === 'link' ? 'destination' : 'absent')
    if (kind === 'link') await mkdir(destination)
    await symlink(destination, target, process.platform === 'win32' ? 'junction' : 'dir')
  }
  await expect(initializeCompanyWorkspace({ initializeDefault }, parent)).rejects.toThrow()
  expect(initializeDefault).toHaveBeenCalledOnce()
  expect((await lstat(target)).isDirectory()).toBe(false)
  if (kind === 'file') expect(await readFile(target, 'utf8')).toBe('preserve')
})

it('rejects a linked parent before calling the official initializer', async () => {
  const { base, parent, initializeDefault } = await fixture()
  const linked = join(base, 'linked')
  await symlink(parent, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(initializeCompanyWorkspace({ initializeDefault }, linked)).rejects.toThrow()
  expect(initializeDefault).toHaveBeenCalledOnce()
})

it('does not resolve the path for an ineligible or previously deleted official default', async () => {
  const { parent } = await fixture()
  const initializeDefault = vi.fn(async (_resolve: () => Promise<string>) => undefined)
  await expect(initializeCompanyWorkspace({ initializeDefault }, parent)).resolves.toBeUndefined()
  expect(initializeDefault).toHaveBeenCalledOnce()
})
