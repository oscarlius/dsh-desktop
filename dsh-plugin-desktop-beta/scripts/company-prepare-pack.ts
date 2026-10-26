/** Compose Next's ASAR/payload seal with the company updater-cache identity. */
import preparePack from './prepare-pack.ts'
import companyBeforePack from './company-update-before-pack.ts'

interface CompanyResourceConfig {
  extraMetadata?: Record<string, unknown> | null
  extraResources?: unknown
}

/** Builder CLI dot/bracket notation cannot represent an extraResources array.
 * beforePack runs before resource matchers are collected; add the Full-only
 * resource here as an actual FileSet without writing its contents to config. */
export function applyCompanyBootstrapResources(config: CompanyResourceConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (config.extraMetadata?.dshDesktopFlavor !== 'companytest') return
  const existing = config.extraResources == null ? [] : Array.isArray(config.extraResources) ? config.extraResources : [config.extraResources]
  const reserved = existing.filter(value => typeof value === 'object' && value !== null
    && (value as { to?: unknown }).to === 'p7-company-connection.json')
  if (config.extraMetadata.dshDesktopUpdateDistribution === true) {
    if (reserved.length > 0) throw new Error('Public update contains a company bootstrap resource')
    return
  }
  const from = env.DSH_P7_BOOTSTRAP_FILE
  if (env.DSH_COMPANY_INITIAL_DISTRIBUTION !== '1' || !from) throw new Error('Company Full requires its explicit protected bootstrap')
  if (reserved.length > 0) throw new Error('Company bootstrap resource was configured more than once')
  config.extraResources = [...existing, { from, to: 'p7-company-connection.json' }]
}

type CompanyPackContext = Parameters<typeof preparePack>[0] & Parameters<typeof companyBeforePack>[0]

export default async function beforePack(context: CompanyPackContext): Promise<void> {
  applyCompanyBootstrapResources(context.packager.config)
  await preparePack(context)
  companyBeforePack(context)
}
