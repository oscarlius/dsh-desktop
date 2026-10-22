/** Presentation-only version labels for internal company builds. */
export function companyBuildVersion(version: string): { readonly visible: string, readonly build?: string } {
  // Older company installers only accept beta.N. Advance the transport patch
  // version for the bridge while retaining the agreed beta15 product label.
  if (version === '2.0.19-beta.15') return { visible: '2.0.18-beta.15', build: '2026102201' }
  const match = /^(2\.0\.18-beta\.15)\.build\.(\d+)$/u.exec(version)
  return match === null ? { visible: version } : { visible: match[1]!, build: match[2]! }
}

export function companyBuildLabel(version: string): string {
  const parsed = companyBuildVersion(version)
  return parsed.build === undefined ? parsed.visible : `${parsed.visible}（构建 ${parsed.build}）`
}
