/** Electron Builder arguments for the two deliberately different company installers. */

export type CompanyPackageDistribution = 'full' | 'update'

export interface CompanyPackageOptions {
  readonly distribution: CompanyPackageDistribution
  readonly output: string
  readonly bootstrapFile?: string
  readonly sourceCommit?: string
}

const SOURCE_COMMIT = /^[0-9a-f]{40}$/u

/** Metadata that must enter package.json before the prepared payload is sealed. */
export function companyPayloadExtraMetadata(environment: NodeJS.ProcessEnv = process.env): Readonly<Record<string, unknown>> | undefined {
  const initial = environment.DSH_COMPANY_INITIAL_DISTRIBUTION === '1'
  const update = environment.DSH_COMPANY_UPDATE_DISTRIBUTION === '1'
  const personal = environment.DSH_COMPANY_PERSONAL_LOGIN_DISTRIBUTION === '1'
  const sourceCommit = environment.DSH_COMPANY_RELEASE_SOURCE_COMMIT
  if (!initial && !update && !personal && sourceCommit === undefined) return undefined
  if ([initial, update, personal].filter(Boolean).length !== 1) throw new Error('Select exactly one company package distribution')
  if (sourceCommit === undefined || !SOURCE_COMMIT.test(sourceCommit)) throw new Error('Company payload requires a 40-character lowercase source commit')
  return { dshCompanyReleaseSourceCommit: sourceCommit, ...(update ? { dshDesktopUpdateDistribution: true } : {}), ...(personal ? { dshDesktopPersonalLoginDistribution: true } : {}) }
}

/**
 * Keep the protected first-install artifact and the credential-free update artifact
 * distinct at the builder boundary. This function is intentionally side-effect free
 * so release tests can prove no bootstrap resource leaks into the update build.
 */
export function companyWindowsBuilderArguments(options: CompanyPackageOptions): readonly string[] {
  const initial = options.distribution === 'full'
  if (initial && (options.bootstrapFile === undefined || options.bootstrapFile.length === 0)) {
    throw new Error('Company Full packaging requires DSH_P7_BOOTSTRAP_FILE')
  }
  if (options.sourceCommit !== undefined && !SOURCE_COMMIT.test(options.sourceCommit)) throw new Error('Company package source commit must be a 40-character lowercase hexadecimal value')
  return [
    '--config.beforePack=scripts/company-prepare-pack.ts',
    '--config.appId=ai.deepseek.dsh.desktop.companytest',
    '--config.productName=P7 DSH Company Test',
    '--config.extraMetadata.dshDesktopFlavor=companytest',
    '--config.nsis.differentialPackage=true',
    `--config.directories.output=${options.output}`,
    `--config.nsis.artifactName=${initial ? 'P7-DSH-Company-Full-${version}-${arch}-Setup.${ext}' : 'P7-DSH-Company-Test-${version}-${arch}-Setup.${ext}'}`,
    ...(options.sourceCommit === undefined ? [] : [`--config.extraMetadata.dshCompanyReleaseSourceCommit=${options.sourceCommit}`]),
    ...(initial ? [] : ['--config.extraMetadata.dshDesktopUpdateDistribution=true']),
  ]
}
