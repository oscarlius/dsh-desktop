/** Stable and Beta identities used to locate each edition's private app data. */
export const DESKTOP_RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    releaseChannel: 'stable' as const,
    packageName: 'dsh-plugin-desktop',
    productName: 'DSH Desktop',
    appId: 'ai.deepseek.dsh.desktop',
    homeDirectoryName: '.dsh',
    updatesEnabled: true,
    accountOnboardingEnabled: true,
  }),
  beta: Object.freeze({
    releaseChannel: 'beta' as const,
    packageName: 'dsh-plugin-desktop-beta',
    productName: 'DSH Desktop Beta',
    appId: 'ai.deepseek.dsh.desktop.beta',
    homeDirectoryName: '.dsh-beta',
    updatesEnabled: true,
    accountOnboardingEnabled: true,
  }),
  companytest: Object.freeze({
    // Test builds remain Beta-compatible only for existing profile metadata;
    // their executable, AppUserModelId, user data and DSH home are isolated.
    releaseChannel: 'beta' as const,
    // The flavor changes app/data identity, while npm self-references must
    // retain the actual installed package.json name and exports.
    packageName: 'dsh-plugin-desktop-beta',
    productName: 'P7 DSH Company Test',
    appId: 'ai.deepseek.dsh.desktop.companytest',
    homeDirectoryName: '.p7-dsh-companytest',
    updatesEnabled: false,
    accountOnboardingEnabled: false,
  }),
})

export type DesktopProductIdentity = typeof DESKTOP_RELEASE_IDENTITIES[keyof typeof DESKTOP_RELEASE_IDENTITIES]

/** Identify the Electron Builder test flavor sealed into the packaged app manifest. */
export function desktopCompanyTestFlavor(manifestText: string | undefined): boolean {
  if (manifestText === undefined) return false
  try {
    return (JSON.parse(manifestText) as { dshDesktopFlavor?: unknown }).dshDesktopFlavor === 'companytest'
  } catch {
    return false
  }
}

/** Resolve the product identity from Electron Builder's sealed package metadata. */
export function desktopProductIdentityForManifest(manifestText: string | undefined): DesktopProductIdentity {
  if (manifestText === undefined) return DESKTOP_RELEASE_IDENTITIES.beta
  const manifest: unknown = JSON.parse(manifestText)
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid Desktop product manifest')
  const flavor = (manifest as { dshDesktopFlavor?: unknown }).dshDesktopFlavor
  if (flavor !== undefined && flavor !== 'companytest' && flavor !== 'beta') throw new Error('Unknown Desktop product flavor')
  return flavor === 'companytest'
    ? DESKTOP_RELEASE_IDENTITIES.companytest
    : DESKTOP_RELEASE_IDENTITIES.beta
}

function packagedManifestText(): string | undefined {
  // Keep the Node lookup dynamic so this Host-owned branch stays out of Vite's client globals.
  const nodeProcess = Reflect.get(globalThis, 'process') as {
    getBuiltinModule?: (name: string) => { readFileSync(path: string | URL, encoding: string): string } | undefined
    resourcesPath?: string
  } | undefined
  const fs = nodeProcess?.getBuiltinModule?.('node:fs')
  if (fs === undefined) return undefined // Browser client; product identity is Host-owned.
  const resourcesPath = nodeProcess?.resourcesPath
  if (resourcesPath !== undefined) {
    // A packaged application must never become Beta after a metadata read failure.
    return fs.readFileSync(`${resourcesPath}/app/package.json`, 'utf8')
  }
  // Utility processes and standalone Node have no Electron resourcesPath.
  // Both source and bundled Host modules live one level below their manifest.
  return fs.readFileSync(new URL(['..', 'package.json'].join('/'), import.meta.url), 'utf8')
}

/** Beta is the normal identity; the internal test identity is sealed by electron-builder metadata. */
export const DESKTOP_PRODUCT_IDENTITY = desktopProductIdentityForManifest(packagedManifestText())
export const OTHER_DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.stable
export const DESKTOP_PACKAGE_NAME = DESKTOP_PRODUCT_IDENTITY.packageName
export const STABLE_DESKTOP_PACKAGE_NAME = OTHER_DESKTOP_PRODUCT_IDENTITY.packageName
export const DESKTOP_PRODUCT_NAME = DESKTOP_PRODUCT_IDENTITY.productName
export const DESKTOP_APP_ID = DESKTOP_PRODUCT_IDENTITY.appId
export const DESKTOP_RELEASE_CHANNEL = DESKTOP_PRODUCT_IDENTITY.releaseChannel
export const DESKTOP_HOME_DIRECTORY_NAME = DESKTOP_PRODUCT_IDENTITY.homeDirectoryName
export const DESKTOP_ACCOUNT_ONBOARDING_ENABLED = DESKTOP_PRODUCT_IDENTITY.accountOnboardingEnabled
export const DESKTOP_COMPANY_SERVICE_ENABLED = DESKTOP_PRODUCT_IDENTITY === DESKTOP_RELEASE_IDENTITIES.companytest
export const DESKTOP_UPDATES_ENABLED = DESKTOP_PRODUCT_IDENTITY.updatesEnabled !== false

/** Both Desktop package identities are launcher-owned, never Profile plugins. */
export const DESKTOP_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  STABLE_DESKTOP_PACKAGE_NAME,
  DESKTOP_PACKAGE_NAME,
])
