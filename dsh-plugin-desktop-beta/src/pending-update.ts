/** Durable, private record for an already-verified company update. */
import { lstatSync, rmSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { atomicJson, privateDirectory, readPrivateFile } from './private-files.ts'

export type PendingCompanyUpdate = Readonly<{
  schema: 1
  status: 'pending' | 'applying' | 'failed'
  version: string
  sha256: string
  sha512?: string
  size?: number
  platform: 'win32' | 'darwin'
  architecture?: 'universal'
  installerPath: string
  installerDirectory: string
  installPath: string
  backupPath?: string
  attempts: number
}>

const FILE = 'pending-update.json'
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value)
const contained = (directory: string, path: string): boolean => {
  const item = relative(resolve(directory), resolve(path))
  return item !== '' && !item.startsWith('..') && !item.includes(':')
}
const ownedDirectory = (cache: string, directory: string): boolean => {
  const root = resolve(cache); const target = resolve(directory)
  if (dirname(target) !== root || !/^download-[A-Za-z0-9]+$/u.test(target.slice(root.length + 1))) return false
  const cacheInfo = lstatSync(root, { throwIfNoEntry: false })
  const info = lstatSync(target, { throwIfNoEntry: false })
  return Boolean(cacheInfo?.isDirectory() && !cacheInfo.isSymbolicLink() && info?.isDirectory() && !info.isSymbolicLink())
}
const ownedInstaller = (cache: string, directory: string, path: string): boolean => {
  if (!ownedDirectory(cache, directory) || dirname(resolve(path)) !== resolve(directory) || !contained(directory, path)) return false
  const info = lstatSync(path, { throwIfNoEntry: false })
  return Boolean(info?.isFile() && !info.isSymbolicLink())
}

export function pendingUpdatePath(cache: string): string { return resolve(cache, FILE) }

export function readPendingCompanyUpdate(cache: string): PendingCompanyUpdate | undefined {
  const text = readPrivateFile(pendingUpdatePath(cache), 16 * 1024)
  if (!text) return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Invalid pending company update') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pending company update')
  const item = value as Record<string, unknown>
  if (item.schema !== 1 || !['pending', 'applying', 'failed'].includes(String(item.status))
    || typeof item.version !== 'string' || !isDigest(item.sha256)
    || (item.sha512 !== undefined && (typeof item.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(item.sha512)))
    || (item.size !== undefined && (!Number.isSafeInteger(item.size) || Number(item.size) <= 0))
    || (item.platform !== 'win32' && item.platform !== 'darwin')
    || (item.architecture !== undefined && item.architecture !== 'universal')
    || typeof item.installerPath !== 'string' || typeof item.installerDirectory !== 'string' || typeof item.installPath !== 'string'
    || (item.backupPath !== undefined && (typeof item.backupPath !== 'string' || resolve(item.backupPath) !== `${resolve(item.installPath)}.p7-pending-backup`))
    || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 0 || Number(item.attempts) > 1
    || !ownedInstaller(cache, item.installerDirectory, item.installerPath)) throw new Error('Invalid pending company update')
  return item as PendingCompanyUpdate
}

export function writePendingCompanyUpdate(cache: string, update: Omit<PendingCompanyUpdate, 'schema' | 'status' | 'attempts'>): PendingCompanyUpdate {
  privateDirectory(cache)
  if (!ownedInstaller(cache, update.installerDirectory, update.installerPath)) throw new Error('Pending installer must be a regular file inside its cache directory')
  const pending: PendingCompanyUpdate = { schema: 1, status: 'pending', attempts: 0, ...update }
  atomicJson(pendingUpdatePath(cache), pending)
  return pending
}

export function markPendingCompanyUpdate(cache: string, update: PendingCompanyUpdate, status: PendingCompanyUpdate['status']): PendingCompanyUpdate {
  const next: PendingCompanyUpdate = { ...update, status, attempts: status === 'applying' ? update.attempts + 1 : update.attempts }
  atomicJson(pendingUpdatePath(cache), next)
  return next
}

export function clearPendingCompanyUpdate(cache: string, update?: PendingCompanyUpdate, installedPath?: string): void {
  if (update && ownedInstaller(cache, update.installerDirectory, update.installerPath)) rmSync(update.installerDirectory, { recursive: true, force: true })
  if (installedPath && update?.backupPath && update.backupPath === `${resolve(installedPath)}.p7-pending-backup`) rmSync(update.backupPath, { recursive: true, force: true })
  rmSync(pendingUpdatePath(cache), { force: true })
}
