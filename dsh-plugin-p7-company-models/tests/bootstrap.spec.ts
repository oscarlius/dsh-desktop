import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { readCompanyBootstrap } from '../src/bootstrap.js'
import { DEFAULT_P7_PUBLIC_ORIGIN } from '../src/defaults.js'

describe('installer-owned company connection', () => {
  it('reads only a valid public-P7 connection and sanitizes malformed secret input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'p7-bootstrap-'))
    const path = join(directory, 'connection.json')
    try {
      expect(await readCompanyBootstrap(path)).toBeUndefined()
      await writeFile(path, JSON.stringify({ origin: DEFAULT_P7_PUBLIC_ORIGIN, key: 'p7k_test-only' }))
      expect(await readCompanyBootstrap(path)).toEqual({ origin: DEFAULT_P7_PUBLIC_ORIGIN, key: 'p7k_test-only' })
      for (const value of ['{"key":"p7k_secret-unclosed', JSON.stringify({ origin: 'https://other.example', key: 'p7k_test' }), 'x'.repeat(8193)]) {
        await writeFile(path, value)
        await expect(readCompanyBootstrap(path)).rejects.toThrow('packaged P7 connection could not be read')
        await expect(readCompanyBootstrap(path)).rejects.not.toThrow('p7k_')
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
