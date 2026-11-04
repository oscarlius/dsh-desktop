/** Company-only defaults for the two bundled productivity plugins.
 *
 * The packages retain ownership of their bundle patches: Mnemon's main bundle
 * patch mounts its Sources and Strategies together, so a Profile must only
 * select `dsh-mnemon` rather than reproduce that insert tree here.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { unpackedPath } from './asar-archive-policy.ts'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

export const COMPANY_DEFAULT_PLUGIN_BUNDLES = ['dsh-better-sidebar', 'dsh-mnemon'] as const

type ProfilePatch = { id?: unknown; disabled?: unknown }

/** A final explicit disabled row belongs to the Profile owner. */
export function hasExplicitCompanyPluginDisable(patches: readonly ProfilePatch[], bundle: typeof COMPANY_DEFAULT_PLUGIN_BUNDLES[number]): boolean {
  const ids = bundle === 'dsh-mnemon' ? new Set(['mnemon', 'mnemon-bundle']) : new Set(['better-sidebar'])
  for (const patch of [...patches].reverse()) {
    if (ids.has(String(patch.id)) && typeof patch.disabled === 'boolean') return patch.disabled
  }
  return false
}

/** Resolve the native binary from the app-owned platform package, never PATH. */
export function companyMnemonCliPath(installAnchor: string): string | undefined {
  try {
    const alias = `@mnemon-dev/mnemon-${process.platform}-${process.arch}`
    const packageFile = createRequire(installAnchor).resolve(`${alias}/package.json`)
    const binary = unpackedPath(join(dirname(packageFile), 'bin', process.platform === 'win32' ? 'mnemon.exe' : 'mnemon'))
    return existsSync(binary) ? binary : undefined
  } catch { return undefined }
}

/** Applied before Profile-owned patches so saved settings continue to win. */
export function companyMemorySpaceProviders(installAnchor: string) {
  const packageFile = createRequire(installAnchor).resolve('dsh-mnemon/package.json')
  const patches = loadOverlayPatches('dsh-mnemon', join(dirname(packageFile), 'cordis.patch.yml'))
  const find = (value: unknown): unknown => {
    if (Array.isArray(value)) { for (const row of value) { const found = find(row); if (found) return found } }
    else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>
      if (row.id === 'mnemon-source-memory-spaces') return (row.config as { providers?: unknown })?.providers
      return find(row.insert) ?? find(row.config)
    }
    return undefined
  }
  const providers = find(patches)
  if (!Array.isArray(providers) || !providers.length) throw new Error('Cannot preserve bundled Memory Spaces providers')
  return [...providers, { use: 'dsh-plugin-p7-company-models/personal-memory-space-provider', instanceId: 'p7-personal-memory' }]
}

export function companyPluginDefaultPatches(mnemonDataDir: string, mnemonCliPath: string | undefined, installAnchor = import.meta.url) {
  return [
    { id: 'better-sidebar', config: { autoOpenSubagent: false, autoOpenJobs: false } },
    { id: 'mnemon', config: {
      idleReview: { enabled: false },
      // Mnemon Native remains local-only and does not start an embedding service.
      embedding: { enabled: false },
      // Never use Mnemon's ~/.mnemon default: company data stays under the
      // product's already isolated DSH_HOME.
      storageScope: 'workspaces', dataDir: mnemonDataDir,
      ...(mnemonCliPath === undefined ? {} : { cliPath: mnemonCliPath }),
      skills: { evolution: false, autoBacktest: false },
    } },
    // Desktop owns its existing Skill management surface. Do not mount Mnemon's
    // experimental second Skills page/source beside it.
    { id: 'mnemon-source-skills', disabled: true },
    { id: 'mnemon-source-memory-spaces', config: {
      providers: companyMemorySpaceProviders(installAnchor),
    } },
  ]
}
