import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearPendingCompanyUpdate, markPendingCompanyUpdate, readPendingCompanyUpdate, writePendingCompanyUpdate } from '../src/pending-update.ts'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

async function pending() {
  root = await mkdtemp(join(tmpdir(), 'p7-pending-update-'))
  const directory = join(root, 'download-abc')
  const installer = join(directory, 'setup.exe')
  await mkdir(directory)
  await writeFile(installer, 'installer')
  return writePendingCompanyUpdate(root, { version: '2.0.18-beta.4', sha256: 'a'.repeat(64), platform: 'win32', installerPath: installer, installerDirectory: directory, installPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\P7 DSH' })
}

describe('pending company update transaction', () => {
  it('persists only a regular installer in its owned cache and survives a new process read', async () => {
    const value = await pending()
    expect(readPendingCompanyUpdate(root)).toEqual(value)
  })
  it('has a single automatic attempt and retains a failed transaction for manual recovery', async () => {
    const value = await pending()
    const applying = markPendingCompanyUpdate(root, value, 'applying')
    expect(applying).toMatchObject({ status: 'applying', attempts: 1 })
    expect(markPendingCompanyUpdate(root, applying, 'failed')).toMatchObject({ status: 'failed', attempts: 1 })
  })
  it('rejects installer paths outside the owned download directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'p7-pending-update-'))
    const installer = join(root, 'setup.exe'); await writeFile(installer, 'installer')
    expect(() => writePendingCompanyUpdate(root, { version: '2.0.18-beta.4', sha256: 'a'.repeat(64), platform: 'win32', installerPath: installer, installerDirectory: join(root, 'download-abc'), installPath: 'C:\\DSH' })).toThrow('Pending installer')
  })
  it('clears only the transaction-owned cache directory', async () => {
    const value = await pending()
    clearPendingCompanyUpdate(root, value)
    expect(readPendingCompanyUpdate(root)).toBeUndefined()
  })
  it('never recursively clears an external directory from tampered pending data', async () => {
    const value = await pending()
    const outside = await mkdtemp(join(tmpdir(), 'p7-pending-outside-'))
    const survivor = join(outside, 'survivor.txt'); await writeFile(survivor, 'keep')
    clearPendingCompanyUpdate(root, { ...value, installerDirectory: outside, installerPath: survivor })
    expect(await readFile(survivor, 'utf8')).toBe('keep')
    await rm(outside, { recursive: true, force: true })
  })
})
