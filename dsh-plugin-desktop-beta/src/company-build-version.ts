/** Presentation-only version labels for internal company builds. */
export function companyBuildVersion(version: string, compatibilityBuild?: string): { readonly visible: string, readonly build?: string } {
  // Older company installers only accept beta.N. Advance the transport patch
  // version for the bridge while retaining the agreed beta15 product label.
  if (version === '2.0.20-beta.15' || version === '2.0.21-beta.15' || version === '2.0.22-beta.15') return compatibilityBuild === undefined
    ? { visible: '2.0.18-beta.15' }
    : { visible: '2.0.18-beta.15', build: compatibilityBuild }
  const match = /^(2\.0\.18-beta\.15)\.build\.(\d+)$/u.exec(version)
  return match === null ? { visible: version } : { visible: match[1]!, build: match[2]! }
}

export function companyBuildLabel(version: string, compatibilityBuild?: string): string {
  const parsed = companyBuildVersion(version, compatibilityBuild)
  return parsed.build === undefined ? parsed.visible : `${parsed.visible}（构建 ${parsed.build}）`
}
