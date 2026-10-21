/** Native-process storage of a Profile's P7 refresh token using OS encryption. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export interface P7SessionVaultRequest { action: 'load' | 'save' | 'clear'; origin: string; refreshToken?: string }
export interface P7SessionVaultResult { refreshToken?: string }
export interface P7SessionProtector {
  available: boolean | (() => boolean | Promise<boolean>)
  seal(value: Uint8Array): Uint8Array | Promise<Uint8Array>
  open(value: Uint8Array): Uint8Array | Promise<Uint8Array>
}

export function createP7SessionVault(profileDir: string, protector: P7SessionProtector): (request: P7SessionVaultRequest) => Promise<P7SessionVaultResult> {
  if (!isAbsolute(profileDir)) throw new TypeError('P7 vault requires an absolute Profile directory')
  const profile = createHash('sha256').update(resolve(profileDir)).digest('hex')
  let pending: Promise<unknown> = Promise.resolve()
  return request => {
    const action = async (): Promise<P7SessionVaultResult> => {
      if (!request || !['load', 'save', 'clear'].includes(request.action)) throw new TypeError('Invalid P7 session storage action')
      const target = new URL(request.origin)
      if (target.protocol !== 'https:' || target.origin !== request.origin || target.username || target.password || target.search || target.hash) throw new TypeError('Invalid P7 session origin')
      const path = join(profileDir, `.p7-session-${createHash('sha256').update(target.origin).digest('hex').slice(0, 32)}.bin`)
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid P7 session storage file')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (request.action === 'clear') {
        await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
        return {}
      }
      const available = typeof protector.available === 'function' ? await protector.available() : protector.available
      if (!available) throw new Error('Operating system encrypted storage is unavailable')
      if (request.action === 'save') {
        if (typeof request.refreshToken !== 'string' || !request.refreshToken.startsWith('p7r_') || request.refreshToken.length > 8192) throw new TypeError('Invalid P7 refresh credential')
        const plaintext = Buffer.from(JSON.stringify({ version: 1, origin: target.origin, profile, refreshToken: request.refreshToken }))
        try {
          const sealed = Buffer.from(await protector.seal(plaintext))
          if (!sealed.length || sealed.length > 65536 || sealed.includes(Buffer.from(request.refreshToken))) throw new Error('P7 session encryption failed')
          await writeFileAtomic(path, sealed, { mode: 0o600, dirMode: 0o700 })
        } finally { plaintext.fill(0) }
        return {}
      }
      let file
      try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
      let plaintext: Buffer | undefined
      try {
        if (!(await file.stat()).isFile() || (await file.stat()).size > 65536) throw new Error('Invalid P7 session storage file')
        plaintext = Buffer.from(await protector.open(await file.readFile()))
        const value = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
        if (value.version !== 1 || value.origin !== target.origin || value.profile !== profile || typeof value.refreshToken !== 'string' || !value.refreshToken.startsWith('p7r_') || value.refreshToken.length > 8192) throw new Error('P7 session storage does not match this Profile')
        return { refreshToken: value.refreshToken }
      } catch { throw new Error('Saved P7 sign-in could not be restored. Sign in again.') }
      finally { plaintext?.fill(0); await file.close() }
    }
    const next = pending.catch(() => {}).then(action)
    pending = next
    return next
  }
}
