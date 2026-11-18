import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const patch = readFileSync(fileURLToPath(new URL('../../patches/dsh-client-ui-plugin-manager@0.2.2-rc.1.patch', import.meta.url)), 'utf8')

it('keeps an enabled installation bundle addressable for its configuration without changing installed semantics', () => {
  expect(patch).toContain('pkg.installed || pkg.official || pkg.error !== void 0 || pkg.enabled && pkg.availability === "installation"')
  expect(patch).toContain('const openPkg = view.kind === "package" || view.kind === "row" ? available.find((pkg) => pkg.name === view.name) : void 0;')
})
