/** Keep NSIS baseline caches isolated from the ordinary Beta application. */
export default function beforePack(context: { packager: {
  config: { extraMetadata?: Record<string, unknown> | null }, appInfo: object,
} }): void {
  const metadata = context.packager.config.extraMetadata
  if (metadata?.dshDesktopFlavor !== 'companytest') return
  const validation = metadata.dshDesktopValidationCacheName
  if (validation !== undefined && (typeof validation !== 'string' || !/^p7-dsh-validation-[a-z0-9-]+-updater$/u.test(validation))) {
    throw new Error('Invalid isolated company validation cache name')
  }
  Object.defineProperty(context.packager.appInfo, 'updaterCacheDirName', {
    value: validation ?? 'p7-dsh-companytest-updater', configurable: true,
  })
}
