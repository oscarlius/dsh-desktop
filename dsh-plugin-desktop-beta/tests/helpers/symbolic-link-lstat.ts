import type { Stats } from 'node:fs'
import { afterEach, vi } from 'vitest'

const original = vi.hoisted(() => ({
  lstatSync: undefined as undefined | typeof import('node:fs').lstatSync,
}))
const lstatSync = vi.hoisted(() => vi.fn())

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  original.lstatSync = fs.lstatSync
  lstatSync.mockImplementation(fs.lstatSync)
  return { ...fs, lstatSync }
})

/**
 * Simulate the lstat result of a file symlink when Windows policy denies
 * unprivileged file-link creation. The target remains a real regular file;
 * production code still reaches its normal lstat-based rejection branch.
 */
export function simulateSymbolicFile(path: string): void {
  const actual = original.lstatSync
  if (actual === undefined) throw new Error('node:fs lstat mock was not initialized')
  const real = actual(path)
  const linked = Object.create(real, {
    isSymbolicLink: { value: () => true },
  }) as Stats
  lstatSync.mockImplementation((candidate: Parameters<typeof actual>[0], ...args: never[]) => (
    candidate === path ? linked : actual(candidate, ...args)
  ))
}

export function restoreLstat(): void {
  const actual = original.lstatSync
  if (actual === undefined) throw new Error('node:fs lstat mock was not initialized')
  lstatSync.mockImplementation(actual)
}

afterEach(restoreLstat)
