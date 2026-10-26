/** Electron Builder arguments for the two deliberately different company installers. */

export type CompanyPackageDistribution = 'full' | 'update'

export interface CompanyPackageOptions {
  readonly distribution: CompanyPackageDistribution
  readonly output: string
  readonly bootstrapFile?: string
  readonly sourceCommit?: string
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
  return [
    '--config.beforePack=scripts/company-prepare-pack.ts',
    '--config.appId=ai.deepseek.dsh.desktop.companytest',
    '--config.productName=P7 DSH Company Test',
    '--config.extraMetadata.dshDesktopFlavor=companytest',
    '--config.nsis.differentialPackage=true',
    `--config.directories.output=${options.output}`,
    `--config.nsis.artifactName=${initial ? 'P7-DSH-Company-Full-${version}-${arch}-Setup.${ext}' : 'P7-DSH-Company-Test-${version}-${arch}-Setup.${ext}'}`,
    ...(options.sourceCommit === undefined ? [] : [`--config.extraMetadata.dshCompanyReleaseSourceCommit=${options.sourceCommit}`]),
    ...(initial
      ? [`--config.extraResources[1].from=${options.bootstrapFile}`, '--config.extraResources[1].to=p7-company-connection.json']
      : ['--config.extraMetadata.dshDesktopUpdateDistribution=true']),
  ]
}
