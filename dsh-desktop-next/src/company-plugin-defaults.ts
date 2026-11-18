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
export function companyPluginDefaultPatches(mnemonDataDir: string, mnemonCliPath: string | undefined) {
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
  ]
}
