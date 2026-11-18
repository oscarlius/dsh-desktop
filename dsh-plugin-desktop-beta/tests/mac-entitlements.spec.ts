import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { macProductName as entitlementProductName, NEXT_MAC_REQUIRED_ENTITLEMENTS, verifyNextMacEntitlements } from '../scripts/verify-mac-entitlements.ts'
import { macProductName as releaseProductName } from '../scripts/verify-mac-release.ts'
import { packagedProductName } from '../scripts/verify-packaged.ts'

const granted = Object.fromEntries(NEXT_MAC_REQUIRED_ENTITLEMENTS.map(key => [key, true]))
const { build } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

it('derives every macOS verifier name from the package build identity', () => {
  expect(entitlementProductName()).toBe(build.productName)
  expect(releaseProductName()).toBe(build.productName)
  expect(packagedProductName(fileURLToPath(new URL('..', import.meta.url)))).toBe(build.productName)
  expect(packagedProductName(fileURLToPath(new URL('..', import.meta.url)), 'Custom Product Override')).toBe('Custom Product Override')
})

it('inherits the pinned upstream entitlement file for the main app and all Helpers', () => {
  expect(build.mac.hardenedRuntime).toBe(true)
  expect(build.mac.extendInfo.NSMicrophoneUsageDescription).toBeTruthy()
  expect(build.mac.entitlements).toBe('../deepseek-harness/apps/desktop/scripts/macos-entitlements.plist')
  expect(build.mac.entitlementsInherit).toBe(build.mac.entitlements)
  const plist = readFileSync(new URL(`../${build.mac.entitlements}`, import.meta.url), 'utf8')
  for (const key of NEXT_MAC_REQUIRED_ENTITLEMENTS) {
    expect(plist).toContain(`<key>${key}</key>\n    <true/>`)
  }
})

it('checks both architectures in the main app and all four Helpers', () => {
  const read = vi.fn(() => granted)
  const appPath = `/mounted/${build.productName}.app`
  verifyNextMacEntitlements(appPath, read)
  expect(read).toHaveBeenCalledTimes(10)
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    for (const arch of ['arm64', 'x86_64']) {
      expect(read).toHaveBeenCalledWith(join(appPath, 'Contents', 'Frameworks', `${build.productName} Helper${suffix}.app`), arch)
    }
  }
})

it.each([undefined, false, 'true'])('rejects missing or non-boolean audio input grants: %s', value => {
  expect(() => verifyNextMacEntitlements(`/mounted/${build.productName}.app`, (path, arch) =>
    path.endsWith('Helper.app') && arch === 'x86_64'
      ? { ...granted, 'com.apple.security.device.audio-input': value } : granted,
  )).toThrow(/audio-input.*Helper.app.*x86_64/)
})

it('propagates a signature inspection failure instead of accepting an unchecked artifact', () => {
  expect(() => verifyNextMacEntitlements(`/mounted/${build.productName}.app`, () => { throw new Error('codesign failed') })).toThrow('codesign failed')
})
