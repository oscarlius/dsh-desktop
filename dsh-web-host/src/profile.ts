import { mkdir, lstat, readlink, symlink, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Install only image-owned package links; never replace employee files. */
export async function linkManagedPackages(profile: string, packages: Readonly<Record<string, string>>): Promise<void> {
  const modules = join(profile, 'node_modules')
  await mkdir(modules, { recursive: true })
  for (const [name, source] of Object.entries(packages)) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('invalid managed package name')
    const target = join(modules, name)
    try {
      const metadata = await lstat(target)
      if (!metadata.isSymbolicLink() || resolve(dirname(target), await readlink(target)) !== resolve(source)) {
        throw new Error(`managed package path is occupied: ${name}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await symlink(resolve(source), target, process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
}

/** Render an image-owned overlay outside personal configuration. */
export async function renderWebPatch(source: string, destination: string, publicOrigin: string, companyOrigin = publicOrigin): Promise<void> {
  for (const originValue of [publicOrigin, companyOrigin]) {
    const origin = new URL(originValue)
    if (origin.protocol !== 'https:' || origin.origin !== originValue) throw new Error('exact HTTPS origins are required')
  }
  const template = await readFile(source, 'utf8')
  const publicPlaceholder = 'https://replace-at-build.invalid'
  const companyPlaceholder = 'https://replace-company-at-build.invalid'
  if (!template.includes(publicPlaceholder) || !template.includes(companyPlaceholder)) throw new Error('Web overlay lacks expected origin placeholders')
  // JSON quoting is valid YAML scalar syntax, including arbitrary URL punctuation.
  const rendered = template
    .replaceAll(publicPlaceholder, JSON.stringify(publicOrigin))
    .replaceAll(companyPlaceholder, JSON.stringify(companyOrigin))
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination + '.tmp', rendered, { mode: 0o600 })
  await rename(destination + '.tmp', destination)
}
