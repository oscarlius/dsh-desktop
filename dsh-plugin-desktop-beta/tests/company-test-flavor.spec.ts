import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopCompanyTestFlavor, desktopProductIdentityForManifest } from '../src/product-identity.ts'

describe('company test product flavor', () => {
  it('accepts only the sealed companytest package marker', () => {
    expect(desktopCompanyTestFlavor('{"dshDesktopFlavor":"companytest"}')).toBe(true)
    expect(desktopCompanyTestFlavor('{"dshDesktopFlavor":"beta"}')).toBe(false)
    expect(desktopCompanyTestFlavor('{not json')).toBe(false)
    expect(desktopCompanyTestFlavor(undefined)).toBe(false)
  })

  it('selects a distinct identity with updates disabled only for the test marker', () => {
    expect(desktopProductIdentityForManifest('{"dshDesktopFlavor":"companytest"}')).toMatchObject({
      productName: 'P7 DSH Company Test',
      appId: 'ai.deepseek.dsh.desktop.companytest',
      homeDirectoryName: '.p7-dsh-companytest',
      updatesEnabled: false,
      accountOnboardingEnabled: false,
    })
    expect(desktopProductIdentityForManifest(undefined)).toMatchObject({
      productName: 'DSH Desktop Beta',
      updatesEnabled: true,
      accountOnboardingEnabled: true,
    })
  })

  it('keeps the installed npm package identity for launcher-owned plugins', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const identity = desktopProductIdentityForManifest(JSON.stringify({ ...manifest, dshDesktopFlavor: 'companytest' }))
    expect(identity.packageName).toBe(manifest.name)
    for (const subpath of ['./webserver', './windows-pwsh-sandbox']) {
      expect(manifest.exports[subpath]).toBeDefined()
    }
  })

  it('rejects invalid product metadata instead of falling back to Beta', () => {
    for (const text of ['{not json', 'null', '[]', '{"dshDesktopFlavor":"typo"}']) {
      expect(() => desktopProductIdentityForManifest(text)).toThrow()
    }
  })

  it('fails startup when the packaged product manifest cannot be read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-company-identity-'))
    const source = new URL('../src/product-identity.ts', import.meta.url).href
    try {
      const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e', `process.resourcesPath = process.argv[1]; const m = await import(${JSON.stringify(source)}); console.log(m.DESKTOP_PRODUCT_NAME, m.DESKTOP_UPDATES_ENABLED)`, directory], { encoding: 'utf8' })
      expect(invoke().status).not.toBe(0)
      mkdirSync(join(directory, 'app'))
      writeFileSync(join(directory, 'app/package.json'), '{not json')
      expect(invoke().status).not.toBe(0)
      writeFileSync(join(directory, 'app/package.json'), '{"dshDesktopFlavor":"companytest"}')
      const company = invoke()
      expect(company.status, company.stderr).toBe(0)
      expect(company.stdout).toContain('P7 DSH Company Test false')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps the sealed identity in a Node Host without Electron resourcesPath', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-company-host-'))
    try {
      mkdirSync(join(directory, 'lib'))
      const source = join(directory, 'lib/product-identity.ts')
      writeFileSync(source, readFileSync(new URL('../src/product-identity.ts', import.meta.url)))
      const invoke = () => spawnSync(process.execPath, ['--input-type=module', '-e', `delete process.resourcesPath; const m = await import(${JSON.stringify(pathToFileURL(source).href)}); console.log(m.DESKTOP_PRODUCT_NAME, m.DESKTOP_UPDATES_ENABLED)`], { encoding: 'utf8' })
      expect(invoke().status).not.toBe(0)
      writeFileSync(join(directory, 'package.json'), '{"type":"module","dshDesktopFlavor":"companytest"}')
      const company = invoke()
      expect(company.status, company.stderr).toBe(0)
      expect(company.stdout).toContain('P7 DSH Company Test false')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
