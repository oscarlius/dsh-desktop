import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createP7SessionVault } from '../src/p7-session-vault.ts'

it('persists only ciphertext, restores after recreation, and binds origin and Profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p7-vault-'))
  const other = await mkdtemp(join(tmpdir(), 'p7-vault-other-'))
  const key = randomBytes(32)
  const protector = { available: () => true,
    seal(value: Uint8Array) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    open(value: Uint8Array) { const raw = Buffer.from(value), decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]) },
  }
  try {
    const save = createP7SessionVault(dir, protector)
    await save({ action: 'save', origin: 'https://p7.example', refreshToken: 'p7r_fixture-only-refresh' })
    const filename = (await readdir(dir)).find(name => name.endsWith('.bin'))!
    const ciphertext = await readFile(join(dir, filename))
    expect(ciphertext.includes(Buffer.from('p7r_fixture-only-refresh'))).toBe(false)
    const reopened = createP7SessionVault(dir, protector)
    await expect(reopened({ action: 'load', origin: 'https://p7.example' })).resolves.toEqual({ refreshToken: 'p7r_fixture-only-refresh' })
    await expect(reopened({ action: 'load', origin: 'https://other.example' })).resolves.toEqual({})
    await writeFile(join(other, filename), ciphertext)
    await expect(createP7SessionVault(other, protector)({ action: 'load', origin: 'https://p7.example' })).rejects.toThrow('could not be restored')
    await reopened({ action: 'clear', origin: 'https://p7.example' })
    await expect(reopened({ action: 'load', origin: 'https://p7.example' })).resolves.toEqual({})
  } finally { await rm(dir, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); key.fill(0) }
})

it('refuses unavailable or plaintext storage and unsafe origins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p7-vault-'))
  try {
    const protector = { available: false, seal: (value: Uint8Array) => value, open: (value: Uint8Array) => value }
    await expect(createP7SessionVault(dir, protector)({ action: 'save', origin: 'https://p7.example', refreshToken: 'p7r_test' })).rejects.toThrow('unavailable')
    await expect(createP7SessionVault(dir, { ...protector, available: true })({ action: 'save', origin: 'https://p7.example', refreshToken: 'p7r_test' })).rejects.toThrow('encryption failed')
    await expect(createP7SessionVault(dir, protector)({ action: 'load', origin: 'https://user:pass@p7.example' })).rejects.toThrow('Invalid')
    expect(await readdir(dir)).toEqual([])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
