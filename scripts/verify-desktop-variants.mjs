import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const nextRoot = join(root, 'dsh-desktop-next')
const betaRoot = join(root, 'dsh-plugin-desktop-beta')
const companyDifferencesFile = join(root, 'scripts/company-variant-differences.json')

/** Reviewed exact-file differences: never a directory-wide exclusion. */
export function readCompanyDifferences(path = companyDifferencesFile) {
  if (!existsSync(path)) return new Map()
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.upstreamCommit) || !Array.isArray(manifest.files)) {
    throw new Error('Invalid company variant difference manifest')
  }
  const entries = new Map()
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.startsWith('/') || entry.path.includes('\\')
      || /[*?\[\]{}]/.test(entry.path)
      || entry.path.split('/').some(part => !part || part === '.' || part === '..')
      || entries.has(entry.path) || typeof entry.reason !== 'string' || !entry.reason.trim()
      || (entry.betaSha256 === null && entry.nextSha256 === null)
      || ![entry.betaSha256, entry.nextSha256].every(hash => hash === null || /^[a-f0-9]{64}$/.test(hash))) {
      throw new Error('Invalid exact company variant difference')
    }
    entries.set(entry.path, entry)
  }
  return entries
}

export function variantContentHash(path) {
  if (!existsSync(path)) return null
  const bytes = isBinaryPath(path) ? readFileSync(path) : readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  return createHash('sha256').update(bytes).digest('hex')
}

const SYNCED_FILES = [
  'package.json',
  'cordis.patch.yml',
  'host.cordis.patch.yml',
  'tsconfig.json',
  'tsconfig.packaging.json',
  'tsdown.config.ts',
  'vite.client.config.ts',
  'vite.native-ui.config.ts',
  'vitest.config.ts',
]

const SYNCED_DIRECTORIES = [
  'assets',
  'scripts',
  'src',
  'tests',
]

const OBSOLETE_BETA_FILES = [
  'components.json',
  'tsconfig.client.json',
  'tsconfig.native-ui.json',
  'tsconfig.tests.client.json',
  'tsconfig.tests.json',
]

const BINARY_EXTENSIONS = new Set(['.png', '.webp', '.ico', '.icns', '.gz'])

function isBinaryPath(relativePath) {
  return BINARY_EXTENSIONS.has(extname(relativePath).toLowerCase())
}

const FILE_SPECIFIC_PAIRS = {
  'package.json': [
    [
      '"description": "Experimental upstream-inspired DSH Desktop with Profiles, recovery, remote control and Community Market"',
      '"description": "Desktop Beta integration for the DeepSeek Harness"',
    ],
    ['--channel next', '--channel beta'],
    [
      'Agentic coding desktop for the DeepSeek Harness (Next)',
      'Agentic coding desktop for the DeepSeek Harness (Beta)',
    ],
    ['"desktopName": "dsh-desktop-next.desktop"', '"desktopName": "dsh-desktop-beta.desktop"'],
    ['"executableName": "dsh-desktop-next"', '"executableName": "dsh-desktop-beta"'],
    ['"packageName": "dsh-desktop-next"', '"packageName": "dsh-desktop-beta"'],
  ],
  'src/data-directory.ts': [
    ["join(userHome, '.dsh')", "join(userHome, '.dsh-beta')"],
  ],
  'tests/data-directory.spec.ts': [
    ["join(user, '.dsh')", "join(user, '.dsh-beta')"],
  ],
  'src/native-ui/onboarding.tsx': [
    ['<span>NEXT</span>', '<span>BETA</span>'],
  ],
}

const GLOBAL_PAIRS = [
  ['linux-unpacked/dsh-desktop-next', 'linux-unpacked/dsh-desktop-beta'],
  ["'linux-unpacked', 'dsh-desktop-next'", "'linux-unpacked', 'dsh-desktop-beta'"],
  ['ai.deepseek.dsh.desktop.next', 'ai.deepseek.dsh.desktop.beta'],
  ['dsh-desktop-next', 'dsh-plugin-desktop-beta'],
  ['DSH NEXT', 'DSH Desktop Beta'],
  ['DSH-NEXT-', 'DSH-Desktop-Beta-'],
  ["sanitizedName: 'DSH-NEXT'", "sanitizedName: 'DSH-Desktop-Beta'"],
  ['DSH_NEXT_BUILD_VERSION', 'DSH_BETA_BUILD_VERSION'],
  ['-next(?:\\.[0-9]+)?', '-beta(?:\\.[0-9]+)?'],
  ['x.y.z-next or x.y.z-next.N', 'x.y.z-beta or x.y.z-beta.N'],
  ["channel: 'next'", "channel: 'beta'"],
  ["'X-DSH-Desktop-Channel': 'next'", "'X-DSH-Desktop-Channel': 'beta'"],
  ["toBe('next')", "toBe('beta')"],
  [
    "desktopUpdateFilename(platform, result.latestVersion, 'next')",
    "desktopUpdateFilename(platform, result.latestVersion, 'beta')",
  ],
]

export function toBetaContent(relativePath, sourceText) {
  let text = sourceText
  for (const [nextStr, betaStr] of FILE_SPECIFIC_PAIRS[relativePath] ?? []) {
    text = text.replaceAll(nextStr, betaStr)
  }
  for (const [nextStr, betaStr] of GLOBAL_PAIRS) {
    text = text.replaceAll(nextStr, betaStr)
  }
  return text
    .replace(
      /(\b\d+\.\d+\.\d+)-next(?:\.(\d+))?\b/gu,
      (_, ver, rev) => `${ver}-beta.${rev ? String(Number(rev) + 1) : '1'}`,
    )
    .replace(
      /(\b\d+\\\.\d+\\\.\d+)-next(?:\\\.(\d+))?\b/gu,
      (_, ver, rev) => `${ver}-beta\\.${rev ? String(Number(rev) + 1) : '1'}`,
    )
    .replace(
      /(\b\d+\\\\\.\d+\\\\\.\d+)-next(?:\\\\\.(\d+))?\b/gu,
      (_, ver, rev) => `${ver}-beta\\\\.${rev ? String(Number(rev) + 1) : '1'}`,
    )
}

export function toNextContent(relativePath, sourceText) {
  let text = sourceText
    .replace(
      /(\b\d+\\\\\.\d+\\\\\.\d+)-beta\\\\\.(\d+)\b/gu,
      (_, ver, rev) => (Number(rev) <= 1 ? `${ver}-next` : `${ver}-next\\\\.${String(Number(rev) - 1)}`),
    )
    .replace(
      /(\b\d+\\\.\d+\\\.\d+)-beta\\\.(\d+)\b/gu,
      (_, ver, rev) => (Number(rev) <= 1 ? `${ver}-next` : `${ver}-next\\.${String(Number(rev) - 1)}`),
    )
    .replace(
      /(\b\d+\.\d+\.\d+)-beta\.(\d+)\b/gu,
      (_, ver, rev) => (Number(rev) <= 1 ? `${ver}-next` : `${ver}-next.${String(Number(rev) - 1)}`),
    )
  for (const [nextStr, betaStr] of [...GLOBAL_PAIRS].reverse()) {
    text = text.replaceAll(betaStr, nextStr)
  }
  for (const [nextStr, betaStr] of [...(FILE_SPECIFIC_PAIRS[relativePath] ?? [])].reverse()) {
    text = text.replaceAll(betaStr, nextStr)
  }
  return text
}

function listDirectoryFiles(baseDir, subDir) {
  const dir = join(baseDir, subDir)
  if (!existsSync(dir)) return []
  const result = []
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile()) result.push(relative(baseDir, fullPath).split(sep).join('/'))
    }
  }
  walk(dir)
  return result
}

function collectSyncedPaths() {
  const paths = new Set(SYNCED_FILES)
  for (const dir of SYNCED_DIRECTORIES) {
    for (const file of listDirectoryFiles(nextRoot, dir)) paths.add(file)
    for (const file of listDirectoryFiles(betaRoot, dir)) paths.add(file)
  }
  return [...paths].sort()
}

export function syncVariants(direction = 'beta-to-next') {
  const companyDifferences = readCompanyDifferences()
  for (const obsolete of OBSOLETE_BETA_FILES) {
    rmSync(join(betaRoot, obsolete), { force: true })
    rmSync(join(nextRoot, obsolete), { force: true })
  }
  const isBetaToNext = direction === 'beta-to-next'
  const sourceRoot = isBetaToNext ? betaRoot : nextRoot
  const targetRoot = isBetaToNext ? nextRoot : betaRoot
  const sourceName = isBetaToNext ? 'dsh-plugin-desktop-beta' : 'dsh-desktop-next'
  const targetName = isBetaToNext ? 'dsh-desktop-next' : 'dsh-plugin-desktop-beta'
  const transform = isBetaToNext ? toNextContent : toBetaContent

  const sourcePaths = new Set(SYNCED_FILES)
  for (const dir of SYNCED_DIRECTORIES) {
    for (const file of listDirectoryFiles(sourceRoot, dir)) sourcePaths.add(file)
  }
  for (const dir of SYNCED_DIRECTORIES) {
    for (const targetFile of listDirectoryFiles(targetRoot, dir)) {
      if (!sourcePaths.has(targetFile) && !companyDifferences.has(targetFile)) {
        rmSync(join(targetRoot, ...targetFile.split('/')), { force: true })
      }
    }
  }
  for (const relPath of [...sourcePaths].sort()) {
    if (companyDifferences.has(relPath)) continue
    const sourceFile = join(sourceRoot, ...relPath.split('/'))
    const targetFile = join(targetRoot, ...relPath.split('/'))
    mkdirSync(dirname(targetFile), { recursive: true })
    if (isBinaryPath(relPath)) {
      writeFileSync(targetFile, readFileSync(sourceFile))
    } else {
      const transformed = transform(relPath, readFileSync(sourceFile, 'utf8'))
      writeFileSync(targetFile, transformed, 'utf8')
    }
    chmodSync(targetFile, statSync(sourceFile).mode)
  }
  process.stdout.write(`verify-desktop-variants: synced ${String(sourcePaths.size)} files from ${sourceName} to ${targetName}\n`)
}

export function verifyVariants() {
  const differences = []
  const companyDifferences = readCompanyDifferences()
  for (const [relPath, entry] of companyDifferences) {
    if (variantContentHash(join(betaRoot, relPath)) !== entry.betaSha256
      || variantContentHash(join(nextRoot, relPath)) !== entry.nextSha256) {
      differences.push(`${relPath} (reviewed company difference changed)`)
    }
  }
  for (const obsolete of OBSOLETE_BETA_FILES) {
    if (existsSync(join(betaRoot, obsolete))) differences.push(`${obsolete} (obsolete file must be removed)`)
  }
  const allPaths = collectSyncedPaths()
  for (const relPath of allPaths) {
    if (companyDifferences.has(relPath)) continue
    const nextFile = join(nextRoot, ...relPath.split('/'))
    const betaFile = join(betaRoot, ...relPath.split('/'))
    if (!existsSync(nextFile) || !existsSync(betaFile)) {
      differences.push(relPath)
      continue
    }
    if (process.platform !== 'win32') {
      const nextExec = (statSync(nextFile).mode & 0o111) !== 0
      const betaExec = (statSync(betaFile).mode & 0o111) !== 0
      if (nextExec !== betaExec) {
        differences.push(`${relPath} (executable permission mismatch)`)
        continue
      }
    }
    if (isBinaryPath(relPath)) {
      if (!readFileSync(nextFile).equals(readFileSync(betaFile))) differences.push(relPath)
    } else {
      const actualNext = readFileSync(nextFile, 'utf8')
      const actualBeta = readFileSync(betaFile, 'utf8')
      const expectedBeta = toBetaContent(relPath, actualNext)
      const expectedNext = toNextContent(relPath, actualBeta)
      if (expectedBeta !== actualBeta || expectedNext !== actualNext) {
        differences.push(relPath)
      }
    }
  }

  if (differences.length > 0) {
    throw new Error(`Desktop variant source drift between Next and Beta is not declared:\n${differences.map(path => `- ${path}`).join('\n')}`)
  }

  process.stdout.write(`verify-desktop-variants: ${String(allPaths.length)} files are aligned between Next and Beta\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2))
  if (args.has('--from=next') || args.has('--sync=beta') || args.has('--next-to-beta')) {
    syncVariants('next-to-beta')
  } else if (args.has('--sync') || args.has('--from=beta') || args.has('--sync=next') || args.has('--beta-to-next')) {
    syncVariants('beta-to-next')
  } else {
    verifyVariants()
  }
}
