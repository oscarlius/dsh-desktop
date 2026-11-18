import { expect, it } from 'vitest'
import { desktopManifestUrl } from '../src/product-identity.ts'

it('prefers the sealed archive root for a Next Host module', () => {
  const resources = 'file:///C:/Program%20Files/P7%20DSH/resources/'
  expect(desktopManifestUrl(resources + 'app.asar/lib/product-identity.js', resources).href)
    .toBe(resources + 'app.asar/package.json')
})

it('reads sealed root metadata for installed modules including nested CLI packages', () => {
  const resources = 'file:///C:/P7/resources/'
  expect(desktopManifestUrl(resources + 'app/lib/identity.js', resources).href).toBe(resources + 'app/package.json')
  expect(desktopManifestUrl(resources + 'app/node_modules/plugin/lib/identity.js', resources).href).toBe(resources + 'app/package.json')
})

it('uses the CLI module package for a development Electron runtime outside its resources', () => {
  expect(desktopManifestUrl('file:///D:/repo/beta/lib/identity.js', 'file:///D:/repo/beta/node_modules/electron/dist/resources/').href).toBe('file:///D:/repo/beta/package.json')
  expect(desktopManifestUrl('file:///D:/repo/beta/src/identity.ts').href).toBe('file:///D:/repo/beta/package.json')
})
