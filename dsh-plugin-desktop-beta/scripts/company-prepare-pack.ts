/** Compose Next's ASAR/payload seal with the company updater-cache identity. */
import preparePack from './prepare-pack.ts'
import companyBeforePack from './company-update-before-pack.ts'

export default async function beforePack(context: Parameters<typeof preparePack>[0]): Promise<void> {
  await preparePack(context)
  companyBeforePack(context)
}
