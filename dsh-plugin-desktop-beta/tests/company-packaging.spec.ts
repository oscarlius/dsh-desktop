import { describe, expect, it } from 'vitest'
import companyBeforePack from '../scripts/company-update-before-pack.ts'
import { companyPayloadExtraMetadata, companyWindowsBuilderArguments } from '../scripts/company-package-options.ts'
import { applyCompanyBootstrapResources } from '../scripts/company-prepare-pack.ts'

const output = 'C:/build/company'

describe('company installer distributions', () => {
  it('places company distribution and source provenance in the payload before sealing', () => {
    const commit = 'a'.repeat(40)
    expect(companyPayloadExtraMetadata({ DSH_COMPANY_INITIAL_DISTRIBUTION: '1', DSH_COMPANY_RELEASE_SOURCE_COMMIT: commit })).toEqual({ dshCompanyReleaseSourceCommit: commit })
    expect(companyPayloadExtraMetadata({ DSH_COMPANY_UPDATE_DISTRIBUTION: '1', DSH_COMPANY_RELEASE_SOURCE_COMMIT: commit })).toEqual({ dshCompanyReleaseSourceCommit: commit, dshDesktopUpdateDistribution: true })
    expect(companyPayloadExtraMetadata({ DSH_COMPANY_PERSONAL_LOGIN_DISTRIBUTION: '1', DSH_COMPANY_RELEASE_SOURCE_COMMIT: commit })).toEqual({ dshCompanyReleaseSourceCommit: commit, dshDesktopPersonalLoginDistribution: true })
    expect(() => companyPayloadExtraMetadata({ DSH_COMPANY_PERSONAL_LOGIN_DISTRIBUTION: '1', DSH_COMPANY_INITIAL_DISTRIBUTION: '1', DSH_COMPANY_RELEASE_SOURCE_COMMIT: commit })).toThrow('exactly one')
    expect(companyPayloadExtraMetadata({})).toBeUndefined()
    expect(() => companyPayloadExtraMetadata({ DSH_COMPANY_INITIAL_DISTRIBUTION: '1', DSH_COMPANY_UPDATE_DISTRIBUTION: '1', DSH_COMPANY_RELEASE_SOURCE_COMMIT: commit })).toThrow('exactly one')
    expect(() => companyPayloadExtraMetadata({ DSH_COMPANY_UPDATE_DISTRIBUTION: '1', DSH_COMPANY_RELEASE_SOURCE_COMMIT: 'not-a-commit' })).toThrow('40-character')
  })
  it('makes the Full installer the only builder mode that receives the protected bootstrap', () => {
    const arguments_ = companyWindowsBuilderArguments({
      distribution: 'full', output, bootstrapFile: 'C:/sealed/p7-company-connection.json', sourceCommit: 'a'.repeat(40),
    })

    expect(arguments_).toEqual(expect.arrayContaining([
      '--config.beforePack=scripts/company-prepare-pack.ts',
      '--config.appId=ai.deepseek.dsh.desktop.companytest',
      '--config.productName=P7 DSH Company Test',
      '--config.nsis.differentialPackage=true',
      '--config.directories.output=C:/build/company',
      '--config.nsis.artifactName=P7-DSH-Company-Full-${version}-${arch}-Setup.${ext}',
      `--config.extraMetadata.dshCompanyReleaseSourceCommit=${'a'.repeat(40)}`,
    ]))
    expect(arguments_.some(value => value.includes('dshDesktopUpdateDistribution'))).toBe(false)
    expect(arguments_.some(value => value.includes('extraResources['))).toBe(false)
  })

  it('makes the differential update credential-free while preserving the ASAR beforePack path', () => {
    const arguments_ = companyWindowsBuilderArguments({ distribution: 'update', output })

    expect(arguments_).toEqual(expect.arrayContaining([
      '--config.beforePack=scripts/company-prepare-pack.ts',
      '--config.extraMetadata.dshDesktopUpdateDistribution=true',
      '--config.nsis.artifactName=P7-DSH-Company-Test-${version}-${arch}-Setup.${ext}',
    ]))
    expect(arguments_.some(value => value.includes('p7-company-connection.json'))).toBe(false)
    expect(arguments_.some(value => value.includes('Company-Full'))).toBe(false)
  })

  it('rejects a Full build without its protected bootstrap before Electron Builder runs', () => {
    expect(() => companyWindowsBuilderArguments({ distribution: 'full', output })).toThrow('DSH_P7_BOOTSTRAP_FILE')
  })

  it('adds the protected resource as a real FileSet only in the Full beforePack context', () => {
    const full = { extraMetadata: { dshDesktopFlavor: 'companytest' }, extraResources: [{ from: 'runtime', to: 'runtime' }] }
    const env = { DSH_COMPANY_INITIAL_DISTRIBUTION: '1', DSH_P7_BOOTSTRAP_FILE: 'C:/sealed/p7-company-connection.json' }
    applyCompanyBootstrapResources(full, env)
    expect(full.extraResources).toEqual([{ from: 'runtime', to: 'runtime' }, { from: env.DSH_P7_BOOTSTRAP_FILE, to: 'p7-company-connection.json' }])
    const update = { extraMetadata: { dshDesktopFlavor: 'companytest', dshDesktopUpdateDistribution: true }, extraResources: [{ from: 'runtime', to: 'runtime' }] }
    applyCompanyBootstrapResources(update, env)
    expect(update.extraResources).toEqual([{ from: 'runtime', to: 'runtime' }])
    expect(() => applyCompanyBootstrapResources(full, env)).toThrow('more than once')
    expect(() => applyCompanyBootstrapResources({ ...update, extraResources: full.extraResources }, env)).toThrow('Public update')
    expect(() => applyCompanyBootstrapResources({ extraMetadata: { dshDesktopFlavor: 'companytest' } }, {})).toThrow('explicit protected bootstrap')
  })
})

describe('company beforePack composition', () => {
  it('isolates the updater cache only for company metadata, leaving ordinary Next packaging unchanged', () => {
    const companyInfo: Record<string, unknown> = {}
    companyBeforePack({ packager: { config: { extraMetadata: { dshDesktopFlavor: 'companytest' } }, appInfo: companyInfo } })
    expect(companyInfo.updaterCacheDirName).toBe('p7-dsh-companytest-updater')

    const ordinaryInfo: Record<string, unknown> = {}
    companyBeforePack({ packager: { config: { extraMetadata: { dshDesktopFlavor: 'beta' } }, appInfo: ordinaryInfo } })
    expect(ordinaryInfo).toEqual({})
  })
})
