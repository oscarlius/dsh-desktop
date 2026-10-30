/** Collect only the verified company Mac DMG and its non-secret release metadata. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readCompanyPackagedManifest } from './publish-company-release.mjs'
import { companyBuildVersion } from '../dsh-plugin-desktop-beta/src/company-build-version.ts'

assert.equal(process.platform, 'darwin', 'Collect the DMG on its native macOS build host')
const root = resolve(import.meta.dirname, '..', 'dsh-plugin-desktop-beta')
const source = join(root, 'dist/mac-smoke')
const dmgs = readdirSync(source).filter(name => name.endsWith('.dmg'))
assert.equal(dmgs.length, 1, 'Expected exactly one verified DMG')
const resources = join(source, 'mac-universal', 'P7 DSH Company Test.app', 'Contents', 'Resources')
const pkg = readCompanyPackagedManifest(resources)
assert.equal(pkg.dshDesktopFlavor, 'companytest')
assert.equal(pkg.dshDesktopPersonalLoginDistribution, true)
assert.notEqual(pkg.dshDesktopUpdateDistribution, true)
assert.equal(pkg.dshCompanyReleaseSourceCommit, process.env.GITHUB_SHA ?? process.env.DSH_COMPANY_RELEASE_SOURCE_COMMIT)
assert.ok(!existsSync(join(resources, 'p7-company-connection.json')), 'Mac test installer must use personal Feishu login')
const presentation = companyBuildVersion(pkg.version, pkg.dshCompanyCompatibilityBuild)
const output = join(root, 'dist/mac-company')
mkdirSync(output, { recursive: true })
const name = `P7-DSH-Company-Test-${pkg.version}-universal.dmg`
const destination = join(output, name)
copyFileSync(join(source, dmgs[0]), destination)
const digest = createHash('sha256')
for await (const chunk of createReadStream(destination)) digest.update(chunk)
const sha256 = digest.digest('hex')
const receipt = { version: pkg.version, displayVersion: presentation.visible, build: presentation.build,
  sourceCommit: pkg.dshCompanyReleaseSourceCommit, platform: process.platform, architecture: 'universal',
  signed: false, signature: 'adhoc', notarized: false, authentication: 'company Feishu personal login',
  artifact: name, bytes: statSync(destination).size, sha256, builtAt: new Date().toISOString() }
writeFileSync(join(output, 'release-manifest.json'), JSON.stringify(receipt, null, 2) + '\n')
writeFileSync(join(output, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`)
const publication = { published: true, channel: 'companytest', platform: 'darwin', architecture: 'universal',
  version: pkg.version, displayVersion: presentation.visible, build: presentation.build, sourceCommit: pkg.dshCompanyReleaseSourceCommit,
  releaseNotes: 'Mac 公司版接入独立 P7 更新通道；支持完整 DMG 下载、安装和重启，保留用户数据。此阶段不启用差分。',
  downloadUrl: `https://maas.zxrc.com.cn:8090/ui/downloads/dsh/companytest-mac/${pkg.version}/${name}`, sha256, size: receipt.bytes }
writeFileSync(join(output, 'p7-macos-latest.json'), JSON.stringify(publication, null, 2) + '\n')
writeFileSync(join(output, 'README.txt'), `P7 DSH 公司版 macOS 通用测试包\n界面版本：${presentation.visible}\n内部构建：${presentation.build}\n支持 Apple Silicon 和 Intel。打开 DMG，将应用拖入 Applications。\n首次启动使用公司飞书账号登录，模型及 MCP 随账号同步。\n这是 ad-hoc 签名的测试包，未经过 Apple Developer ID 签名及公证。\n本包接入独立 P7 Mac 更新通道；现有 2026103001 测试包需要手动安装本包一次，后续在版本管理中更新。\n源码：${pkg.dshCompanyReleaseSourceCommit}\n`)
console.log(JSON.stringify(receipt))
