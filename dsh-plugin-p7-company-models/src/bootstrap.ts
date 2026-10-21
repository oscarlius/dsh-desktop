import { readFile, stat } from 'node:fs/promises'
import { DEFAULT_P7_PUBLIC_ORIGIN } from './defaults.js'

export interface CompanyBootstrap { origin: string; key: string }

/** Installer-owned connection material stays on the Host, outside browser bundles. */
export async function readCompanyBootstrap(path: string): Promise<CompanyBootstrap | undefined> {
  if (!path) return undefined
  try {
    if ((await stat(path)).size > 8192) throw new Error('size')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('shape')
    const record = value as Record<string, unknown>
    if (record.origin !== DEFAULT_P7_PUBLIC_ORIGIN || typeof record.key !== 'string'
      || !/^p7k_[\x21-\x7e]+$/.test(record.key) || record.key.length > 4096) throw new Error('connection')
    return { origin: record.origin, key: record.key }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // Parsing and filesystem errors may contain secret-bearing source text.
    throw new Error('The packaged P7 connection could not be read. Reinstall the company client or connect manually.')
  }
}
