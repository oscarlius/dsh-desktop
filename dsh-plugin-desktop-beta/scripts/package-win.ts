/** Build an unsigned Windows x64 artifact on a native Windows host. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { DEFAULT_P7_PUBLIC_ORIGIN } from 'dsh-plugin-p7-company-models/defaults'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareFsExtForElectron } from './prepare-fs-ext.ts'
import { electronBuilderEnvironment } from './electron-builder-environment.ts'
import { prepareDesktopInterpreters, verifyPreparedDesktopRuntime } from './prepare-runtime.ts'

const WINDOWS_SIGNING_KEYS = [
  'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
  'CSC_NAME',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
] as const

const WINDOWS_COMPRESSION_LEVELS = new Set(['store', 'normal', 'maximum'])

/**
 * Read an optional electron-builder compression override for unsigned CI
 * artifacts. Compression dominates the Windows job while the smoke artifacts
 * are never published, so CI may select `store`; release builds leave the
 * variable unset and keep `build.win.compression`.
 * @param environment - Environment of the packaging process.
 * @returns The override, or `undefined` to keep the package configuration.
 */
export function windowsCompressionOverride(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const value = environment.DSH_WINDOWS_PACKAGE_COMPRESSION
  if (value === undefined || value === '') return undefined
  if (!WINDOWS_COMPRESSION_LEVELS.has(value)) {
    throw new Error(
      `DSH_WINDOWS_PACKAGE_COMPRESSION must be store, normal, or maximum; received ${JSON.stringify(value)}`,
    )
  }
  return value
}

/** Injectable native Windows packaging boundary used by focused tests. */
export interface WindowsPackageOptions {
  /** Environment inherited by the packaging command. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the package build. */
  readonly platform: NodeJS.Platform
  /** Node architecture executing the package build. */
  readonly arch: string
  /** Node version executing the package build. */
  readonly nodeVersion: string
  /** Repository root containing the Yarn workspace. */
  readonly workspaceRoot: string
  /** Desktop package root containing electron-builder configuration. */
  readonly desktopRoot: string
  /** Absolute native Windows command interpreter. */
  readonly commandShell: string
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Prepare platform-specific native runtime dependencies before packaging. */
  readonly prepareRuntime: () => void
  /** Absolute packaged-installer verification script. */
  readonly verifier: string
  /** Node executable used to run package-local scripts. */
  readonly nodeExecutable: string
  /** Execute one packaging command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret packaging progress. */
  readonly log: (message: string) => void
  /** Extra electron-builder configuration arguments for a constrained flavor. */
  readonly builderArguments?: readonly string[]
  /** Command used for the non-skippable preflight of a constrained flavor. */
  readonly preflightCommand?: string
  /** Ignore the ordinary CI preflight bypass for this packaging operation. */
  readonly requirePackageCheck?: boolean
}

export const COMPANY_TEST_WINDOWS_BUILD_ARGUMENTS = [
  '--config.beforePack=scripts/company-update-before-pack.ts',
  '--config.publish.provider=generic',
  '--config.publish.url=https://maas.zxrc.com.cn:8090/v1/desktop/releases/companytest/',
  '--config.publish.channel=latest',
  '--config.appId=ai.deepseek.dsh.desktop.companytest',
  '--config.productName=P7 DSH Company Test',
  '--config.extraMetadata.dshDesktopFlavor=companytest',
  '--config.win.artifactName=P7-DSH-Company-Test-${version}-${arch}-Portable.${ext}',
  '--config.nsis.shortcutName=P7 DSH Company Test',
  '--config.nsis.artifactName=P7-DSH-Company-Test-${version}-${arch}-Setup.${ext}',
] as const

const COMPANY_TEST_WINDOWS_PREFLIGHT = [
  'corepack yarn market:check',
  'corepack yarn aa:prepare-release --verify-release',
  'corepack yarn workspace dsh-plugin-desktop-beta check:win-package',
].join(' && ')

/**
 * Remove all certificate discovery and secret variables from an unsigned build.
 * @param environment - Environment that may contain Windows signing configuration.
 * @returns A copy suitable for checks and unsigned packaging.
 */
export function withoutWindowsSigningSecrets(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment }
  const signingKeys = new Set<string>(WINDOWS_SIGNING_KEYS)
  for (const key of Object.keys(sanitized)) {
    if (signingKeys.has(key.toUpperCase())) delete sanitized[key]
  }
  return sanitized
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/** Create the native packaging options for a verifier entry point. */
export function createWindowsPackageOptions(verifier = './verify-win-installer.ts'): WindowsPackageOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const require = createRequire(import.meta.url)
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceRoot,
    desktopRoot,
    commandShell: windowsRoot === undefined || windowsRoot.length === 0
      ? 'cmd.exe'
      : join(windowsRoot, 'System32', 'cmd.exe'),
    builderCli: require.resolve('electron-builder/cli.js'),
    prepareRuntime: () => {
      if (process.env.DSH_COMPANY_TEST_WINDOWS === '1' && process.env.DSH_COMPANY_UPDATE_DISTRIBUTION !== '1') {
        const destination = join(desktopRoot, '.desktop-build', 'company', 'p7-company-connection.json')
        const source = process.env.DSH_P7_BOOTSTRAP_FILE ?? destination
        try {
          if (statSync(source).size > 8192) throw new Error('size')
          const value = JSON.parse(readFileSync(source, 'utf8')) as { origin?: unknown; key?: unknown }
          if (value.origin !== DEFAULT_P7_PUBLIC_ORIGIN || typeof value.key !== 'string'
            || !/^p7k_[\x21-\x7e]+$/.test(value.key) || value.key.length > 4096) throw new Error('connection')
          if (resolve(source) !== resolve(destination)) {
            mkdirSync(dirname(destination), { recursive: true })
            copyFileSync(source, destination)
          }
        } catch {
          throw new Error('Company packaging requires a valid protected P7 connection file (DSH_P7_BOOTSTRAP_FILE).')
        }
      }
      prepareFsExtForElectron({ platform: 'win32', arch: 'x64', desktopRoot })
      verifyPreparedDesktopRuntime(desktopRoot, 'win32')
    },
    verifier: fileURLToPath(new URL(verifier, import.meta.url)),
    nodeExecutable: process.execPath,
    run,
    log: message => console.log(message),
  }
}

/** Run the shared host and Node release gates before packaging. */
function assertWindowsPackageHost(options: WindowsPackageOptions, artifact: string): void {
  if (options.platform !== 'win32') {
    throw new Error(`Windows ${artifact} must be built on a native Windows host`)
  }
  if (options.arch !== 'x64') {
    throw new Error(`Windows ${artifact} requires x64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `Windows ${artifact} requires Node 22.19+ or Node 24.x with bundled Corepack; received ${options.nodeVersion}`,
    )
  }
}

/** Run the gates and package one unsigned x64 Windows artifact. */
export function packageWindowsArtifact(
  options: WindowsPackageOptions,
  target: 'nsis' | 'zip',
  artifact: 'installer' | 'portable archive',
): void {
  assertWindowsPackageHost(options, artifact)
  const compression = windowsCompressionOverride(options.env)

  const cleanEnvironment = withoutWindowsSigningSecrets(options.env)
  options.log(`Building an unsigned Windows x64 ${artifact}; Authenticode is a separate release step.`)
  if (compression !== undefined) {
    options.log(`Packaging the ${artifact} with ${compression} compression.`)
  }
  if (options.requirePackageCheck || options.env.DSH_PACKAGE_CHECK_ALREADY_RAN !== '1') {
    options.run(
      options.commandShell,
      [
        '/d',
        '/s',
        '/c',
        options.preflightCommand ?? 'corepack yarn workspace dsh-plugin-desktop-beta check:win-package',
      ],
      options.workspaceRoot,
      cleanEnvironment,
    )
  } else {
    options.log('Skipping the Windows package preflight; the package gate already passed.')
  }
  options.prepareRuntime()
  options.run(
    options.nodeExecutable,
    [
      options.builderCli,
      '--win',
      target,
      '--x64',
      '--publish',
      'never',
      '--config.win.signExecutable=false',
      '--config.npmRebuild=false',
      '--config.electronFuses.onlyLoadAppFromAsar=false',
      ...(options.builderArguments ?? []),
      ...(compression === undefined ? [] : [`--config.win.compression=${compression}`]),
    ],
    options.desktopRoot,
    electronBuilderEnvironment({
      ...cleanEnvironment,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    }),
  )
  options.run(
    options.nodeExecutable,
    [options.verifier],
    options.desktopRoot,
    cleanEnvironment,
  )
}

/** Run the headless release gates and package one unsigned x64 NSIS installer. */
export function packageWindowsInstaller(
  options: WindowsPackageOptions = createWindowsPackageOptions(),
): void {
  packageWindowsArtifact(options, 'nsis', 'installer')
}

/** Package the isolated internal P7 test installer without accepting CI gate bypasses. */
export function packageCompanyTestWindowsInstaller(
  options: WindowsPackageOptions = createWindowsPackageOptions('./company-test-windows-verify.mjs'),
): void {
  packageWindowsArtifact({
    ...options,
    builderArguments: [
      ...COMPANY_TEST_WINDOWS_BUILD_ARGUMENTS,
      ...(options.env.DSH_COMPANY_UPDATE_DISTRIBUTION === '1'
        ? ['--config.extraMetadata.dshDesktopUpdateDistribution=true'] : []),
    ],
    preflightCommand: COMPANY_TEST_WINDOWS_PREFLIGHT,
    requirePackageCheck: true,
  }, 'nsis', 'installer')
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--company-update')) {
    process.env.DSH_COMPANY_TEST_WINDOWS = '1'
    process.env.DSH_COMPANY_UPDATE_DISTRIBUTION = '1'
  }
  try {
    // The interpreter payload is downloaded and assembled before the long package gate; the flow re-checks it right before electron-builder.
    await prepareDesktopInterpreters({ desktopRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..') })
    if (process.env.DSH_COMPANY_TEST_WINDOWS === '1') {
      packageCompanyTestWindowsInstaller(createWindowsPackageOptions('./company-test-windows-verify.mjs'))
    } else {
      packageWindowsInstaller()
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
