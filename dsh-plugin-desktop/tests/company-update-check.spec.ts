import { describe, expect, it, vi } from 'vitest'
import { checkCompanyRelease, COMPANY_RELEASE_ENDPOINT } from '../src/company-update-check.ts'

const release = () => ({
  published: true, channel: 'companytest', version: '2.0.18-beta.4', releaseNotes: '公司更新说明',
  downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/P7-DSH-Company-Test-2.0.18-beta.4-x64-Setup.exe',
  sha256: 'a'.repeat(64),
})

describe('company release metadata', () => {
  it('queries only public P7, omits credentials, and compares the published version', async () => {
    const request = vi.fn(async () => Response.json(release()))
    const result = await checkCompanyRelease('2.0.18-beta.3', request)
    expect(result).toMatchObject({ status: 'update-available', version: '2.0.18-beta.4' })
    expect(request).toHaveBeenCalledWith(COMPANY_RELEASE_ENDPOINT, expect.objectContaining({
      redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json', 'X-DSH-Desktop-Version': '2.0.18-beta.3' },
    }))
  })
  it('distinguishes no published release from a verified current version', async () => {
    expect(await checkCompanyRelease('2.0.18-beta.3', async () => Response.json({ published: false, channel: 'companytest' }))).toEqual({ status: 'not-published' })
    expect(await checkCompanyRelease('2.0.18-beta.4', async () => Response.json(release()))).toMatchObject({ status: 'up-to-date' })
  })
  it.each([
    { channel: 'stable' }, { version: 'invalid' }, { sha256: '' },
    { downloadUrl: 'http://maas.zxrc.com.cn:8090/ui/downloads/setup.exe' },
    { downloadUrl: 'https://attacker.example/setup.exe' },
    { downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/setup.exe?key=secret' },
    { downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/%2e%2e/setup.exe' },
    { downloadUrl: 'https://maas.zxrc.com.cn:8090/ui/downloads/setup.js' },
  ])('rejects a malformed or foreign release %j', async override => {
    await expect(checkCompanyRelease('2.0.18-beta.3', async () => Response.json({ ...release(), ...override }))).rejects.toThrow()
  })
  it('bounds response bytes and preserves cancellation', async () => {
    await expect(checkCompanyRelease('2.0.18-beta.3', async () => new Response('x'.repeat(128 * 1024 + 1)))).rejects.toThrow('too large')
    const signal = AbortSignal.abort()
    const request = vi.fn(async () => { throw new DOMException('aborted', 'AbortError') })
    await expect(checkCompanyRelease('2.0.18-beta.3', request, signal)).rejects.toThrow('aborted')
    expect(request).toHaveBeenCalledWith(COMPANY_RELEASE_ENDPOINT, expect.objectContaining({ signal }))
  })
})
