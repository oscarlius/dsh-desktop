import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** 由官方注册表决定首次创建资格并持久化默认工作区身份。 */
export async function initializeCompanyWorkspace(
  registry: Pick<WorkspaceRegistry, 'initializeDefault'>,
  parent = '/workspace',
): Promise<Awaited<ReturnType<WorkspaceRegistry['initializeDefault']>>> {
  // 仅在官方注册表允许首次创建时检查路径；检查与创建之间不是原子操作。
  return registry.initializeDefault(async () => {
    const root = await lstat(parent)
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new Error('Default workspace parent must be a direct directory.')
    }
    const target = join(parent, '投研工作')
    try {
      const entry = await lstat(target)
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(target) !== target) {
        throw new Error('Default workspace target must be a direct directory.')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return target
  })
}
