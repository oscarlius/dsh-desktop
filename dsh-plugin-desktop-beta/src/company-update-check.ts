/** Manual release metadata reads from the company's public P7 gateway. */
import { compareSemVerVersions, parseSemVer, type UpdateRequest } from '../../dsh-plugin-desktop/src/update-checker.ts'
import { DEFAULT_P7_PUBLIC_ORIGIN } from 'dsh-plugin-p7-company-models/defaults'

export const COMPANY_RELEASE_ENDPOINT = `${DEFAULT_P7_PUBLIC_ORIGIN}/v1/desktop/releases/latest`
export const COMPANY_MAC_RELEASE_ENDPOINT = `${DEFAULT_P7_PUBLIC_ORIGIN}/v1/desktop/releases/macos/latest`
const MAX_RELEASE_BYTES = 128 * 1024

export type CompanyReleaseResult = { status: 'not-published' } | {
  status: 'up-to-date' | 'update-available'
  version: string
  releaseNotes: string
  downloadUrl: string
  sha256: string
  /** Absent on the legacy Windows contract. Mac metadata must explicitly identify its payload. */
  platform?: 'darwin'
  architecture?: 'universal'
  /** Present only for releases published with an immutable differential feed. */
  updaterFeedUrl?: string
  sha512?: string
  size?: number
}

export type PublishedCompanyRelease = Exclude<CompanyReleaseResult, { status: 'not-published' }>

/** Validate the one credential-free update installer published for a release version. */
export function companyInstallerUrl(value: string, version: string, platform: 'win32' | 'darwin' = 'win32'): string {
  if (parseSemVer(version)?.version !== version) throw new Error('Invalid P7 installer version')
  const url = new URL(value)
  const filename = platform === 'darwin' ? `P7-DSH-Company-Test-${version}-universal.dmg` : `P7-DSH-Company-Test-${version}-x64-Setup.exe`
  if (url.origin !== DEFAULT_P7_PUBLIC_ORIGIN || url.protocol !== 'https:' || url.username || url.password
    || url.search || url.hash || !url.pathname.startsWith('/ui/downloads/')
    || !url.pathname.endsWith(`/${filename}`) || /%|\\|\s/iu.test(value)) throw new Error('Invalid P7 installer address')
  if (platform === 'darwin' && url.pathname !== `/ui/downloads/dsh/companytest-mac/${version}/${filename}`) throw new Error('Invalid P7 Mac installer address')
  return url.href
}

export async function checkCompanyRelease(currentVersion: string, request: UpdateRequest, signal?: AbortSignal, platform: 'win32' | 'darwin' = 'win32'): Promise<CompanyReleaseResult> {
  if (parseSemVer(currentVersion) === null) throw new Error('Invalid current company version')
  const response = await request(platform === 'darwin' ? COMPANY_MAC_RELEASE_ENDPOINT : COMPANY_RELEASE_ENDPOINT, {
    method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
    headers: { Accept: 'application/json', 'X-DSH-Desktop-Version': currentVersion },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok || response.body === null) throw new Error('P7 release metadata is unavailable')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RELEASE_BYTES) {
        await reader.cancel()
        throw new Error('P7 release metadata is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
  } finally { reader.releaseLock() }
  const value: unknown = JSON.parse(body)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid P7 release metadata')
  const release = value as Record<string, unknown>
  if (release.channel !== 'companytest' || typeof release.published !== 'boolean') throw new Error('Invalid P7 release channel')
  if (!release.published) return { status: 'not-published' }
  if (typeof release.version !== 'string' || parseSemVer(release.version)?.version !== release.version
    || typeof release.releaseNotes !== 'string' || release.releaseNotes.length > 20000
    || typeof release.downloadUrl !== 'string' || typeof release.sha256 !== 'string'
    || !/^[a-fA-F0-9]{64}$/u.test(release.sha256)) throw new Error('Incomplete P7 release metadata')
  if (platform === 'darwin' && (release.platform !== 'darwin' || release.architecture !== 'universal'
    || !Number.isSafeInteger(release.size) || Number(release.size) <= 0 || Number(release.size) > 1024 ** 3)) throw new Error('Invalid P7 Mac release metadata')
  const downloadUrl = companyInstallerUrl(release.downloadUrl, release.version, platform)
  let differential: Pick<PublishedCompanyRelease, 'updaterFeedUrl' | 'sha512' | 'size'> = {}
  if (platform === 'win32' && release.updaterFeedUrl !== undefined && release.updaterFeedUrl !== null) {
    const feed = new URL(String(release.updaterFeedUrl))
    if (feed.href !== `${DEFAULT_P7_PUBLIC_ORIGIN}/v1/desktop/releases/companytest/`
      || typeof release.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(release.sha512)
      || !Number.isSafeInteger(release.size) || Number(release.size) <= 0 || Number(release.size) > 1024 ** 3) {
      throw new Error('Invalid P7 differential release metadata')
    }
    differential = { updaterFeedUrl: feed.href, sha512: release.sha512, size: Number(release.size) }
  }
  return {
    status: (compareSemVerVersions(release.version, currentVersion) ?? 0) > 0 ? 'update-available' : 'up-to-date',
    version: release.version, releaseNotes: release.releaseNotes, downloadUrl,
    sha256: release.sha256.toLowerCase(),
    ...(platform === 'darwin' ? { platform, architecture: 'universal' as const, size: Number(release.size) } : {}),
    ...differential,
  }
}
