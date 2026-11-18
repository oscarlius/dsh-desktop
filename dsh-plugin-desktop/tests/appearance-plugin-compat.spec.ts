import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { patchAppearancePluginSource } from '../src/appearance-plugin-compat.ts'

const temporaryDirectories: string[] = []
const gunzipAsync = promisify(gunzip)
const stockSourcePath = process.env.DSH_ANY_BACKGROUND_039_SOURCE
  ?? join(import.meta.dirname, 'fixtures', 'dsh-any-background-0.3.9-index.js.gz')

async function fixture(version = '0.3.9'): Promise<{ modulePath: string, profileDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-appearance-compat-'))
  temporaryDirectories.push(root)
  const profileDirectory = join(root, 'profile')
  const packageDirectory = join(profileDirectory, 'node_modules', 'dsh-any-background')
  const modulePath = join(packageDirectory, 'lib', 'index.js')
  await mkdir(join(packageDirectory, 'lib'), { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name: 'dsh-any-background', version }))
  return { modulePath, profileDirectory }
}

async function stockSource(): Promise<string> {
  const source = await readFile(stockSourcePath)
  return stockSourcePath.endsWith('.gz')
    ? (await gunzipAsync(source)).toString('utf8')
    : source.toString('utf8')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('patchAppearancePluginSource', () => {
  it('leaves unknown source, release, and paths outside the active Profile untouched', async () => {
    const known = await fixture()
    const changedRelease = await fixture('0.3.10')
    const source = 'export const plugin = true\n'
    await writeFile(known.modulePath, source)
    await writeFile(changedRelease.modulePath, source)

    expect(patchAppearancePluginSource(known.modulePath, known.profileDirectory, source)).toBeUndefined()
    expect(patchAppearancePluginSource(changedRelease.modulePath, changedRelease.profileDirectory, source)).toBeUndefined()
    expect(patchAppearancePluginSource(known.modulePath, join(known.profileDirectory, 'other'), source)).toBeUndefined()
  })

  it('guards the stock bundle hash and replaces only its known writer', async () => {
    const { modulePath, profileDirectory } = await fixture()
    const source = await stockSource()
    await writeFile(modulePath, source)
    const patched = patchAppearancePluginSource(modulePath, profileDirectory, source)

    expect(patched).toContain('import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";')
    expect(patched).toContain('const __dshAppearanceWriteTails = new Map();')
    expect(patched).toContain('withFileLock(path, () => writeFileAtomic(path, JSON.stringify(normalized, null, 2), { mode: 0o600 }))')
    expect(patched).toContain('resolvePackageManifest?.("@deepseek-ai/dsh")')
    expect(patched).toContain('resolveHostInfo(__dshAppearanceActualDshAnchor(ctx))')
    expect(patchAppearancePluginSource(modulePath, profileDirectory, `${source}\n`)).toBeUndefined()
  })

  it('serializes 32 rapid saves without corrupting JSON or poisoning the write tail', async () => {
    const { modulePath, profileDirectory } = await fixture()
    const source = await stockSource()
    await writeFile(modulePath, source)
    const patched = patchAppearancePluginSource(modulePath, profileDirectory, source)
    if (patched === undefined) throw new Error('expected stock source to be patched')
    const start = patched.indexOf('async function writeConfig(config)')
    const end = patched.indexOf('/** The wallpaper slot', start)
    const writeConfigSource = patched.slice(start, end)
    const configDirectory = join(profileDirectory, 'state')
    const configPath = join(configDirectory, 'theme-config.json')
    let drops = 0
    let ensureAttempts = 0
    const makeWriteConfig = new Function(
      'ensureDir', 'configPath', 'normalizeConfig', 'warnUnknownConfigKeys', 'dropConfigCache', 'withFileLock', 'writeFileAtomic', 'CONFIG_FILE',
      `const __dshAppearanceWriteTails = new Map(); ${writeConfigSource}; return writeConfig`,
    ) as (
      ensureDir: () => Promise<void>, configPath: () => string, normalizeConfig: (value: unknown) => unknown,
      warnUnknownConfigKeys: (input: unknown, normalized: unknown) => void, dropConfigCache: () => void,
      lock: typeof withFileLock, atomicWrite: typeof writeFileAtomic, configFile: string,
    ) => (value: unknown) => Promise<boolean>
    const writeConfig = makeWriteConfig(
      async () => {
        ensureAttempts += 1
        if (ensureAttempts === 1) throw new Error('transient fixture failure')
        await mkdir(configDirectory, { recursive: true })
      }, () => configPath, value => value, () => { }, () => { drops += 1 },
      withFileLock, writeFileAtomic, 'theme-config.json',
    )

    await expect(writeConfig({ sequence: -1 })).resolves.toBe(false)
    await expect(Promise.all(Array.from({ length: 32 }, (_, sequence) => writeConfig({ sequence })))).resolves.toEqual(Array(32).fill(true))
    await expect(readFile(configPath, 'utf8')).resolves.toBe(JSON.stringify({ sequence: 31 }, null, 2))
    expect(drops).toBe(32)
  })
})
