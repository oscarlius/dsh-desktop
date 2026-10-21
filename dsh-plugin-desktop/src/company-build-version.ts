/** Presentation-only version labels for internal company builds. */
export function companyBuildVersion(version: string): { readonly visible: string, readonly build?: string } {
  const match = /^(2\.0\.18-beta\.15)\.build\.(\d+)$/u.exec(version)
  return match === null ? { visible: version } : { visible: match[1]!, build: match[2]! }
}

export function companyBuildLabel(version: string): string {
  const parsed = companyBuildVersion(version)
  return parsed.build === undefined ? parsed.visible : `${parsed.visible}（构建 ${parsed.build}）`
}
