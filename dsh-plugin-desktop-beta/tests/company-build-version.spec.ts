import { describe, expect, it } from 'vitest'
import { companyBuildLabel, companyBuildVersion } from '../src/company-build-version.ts'
import { checkCompanyRelease } from '../src/company-update-check.ts'

describe('beta15 compatibility bridge', () => {
  it('keeps the product label and build separate from the legacy-compatible transport version', () => {
    expect(companyBuildVersion('2.0.20-beta.15', '2026102601')).toEqual({ visible: '2.0.18-beta.15', build: '2026102601' })
    expect(companyBuildLabel('2.0.20-beta.15', '2026102601')).toBe('2.0.18-beta.15（构建 2026102601）')
    expect(companyBuildVersion('2.0.18-beta.15.build.2026102102')).toEqual({ visible: '2.0.18-beta.15', build: '2026102102' })
    expect(companyBuildVersion('2.0.20')).toEqual({ visible: '2.0.20' })
  })

  it.each(['2.0.18-beta.14', '2.0.18-beta.15', '2.0.18-beta.16', '2.0.18-beta.15.build.2026102102'])(
    'offers the bridge to %s and compares using its full transport version', async current => {
      const result = await checkCompanyRelease(current, async () => Response.json({
        published: true, channel: 'companytest', version: '2.0.20-beta.15', releaseNotes: 'Compatibility bridge',
        downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/dsh/companytest/2.0.20-beta.15/P7-DSH-Company-Test-2.0.20-beta.15-x64-Setup.exe',
        sha256: 'a'.repeat(64),
      }))
      expect(result).toMatchObject({ status: 'update-available', version: '2.0.20-beta.15' })
    },
  )
})
