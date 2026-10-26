import { describe, expect, it } from 'vitest'
import companyBeforePack from '../scripts/company-update-before-pack.ts'
import { companyWindowsBuilderArguments } from '../scripts/company-package-options.ts'

const output = 'C:/build/company'

describe('company installer distributions', () => {
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
      '--config.extraResources[1].from=C:/sealed/p7-company-connection.json',
      '--config.extraResources[1].to=p7-company-connection.json',
      `--config.extraMetadata.dshCompanyReleaseSourceCommit=${'a'.repeat(40)}`,
    ]))
    expect(arguments_.some(value => value.includes('dshDesktopUpdateDistribution'))).toBe(false)
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
