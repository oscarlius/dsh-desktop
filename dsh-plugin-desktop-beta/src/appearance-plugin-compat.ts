/** Narrow runtime compatibility adapter for a known Profile plugin bundle. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ModuleSource } from 'node:module'

const PACKAGE_NAME = 'dsh-any-background'
const PACKAGE_VERSION = '0.3.9'
const SOURCE_SHA256 = 'a019acc1b77235a492fe7dbf7bc00bfdbc12da585d156b805637cb32c60fe6d2'
const MODULE_SUFFIX = ['node_modules', PACKAGE_NAME, 'lib', 'index.js'].join(sep)

const STOCK_WRITE_CONFIG = `async function writeConfig(config) {
\tawait ensureDir();
\tconst tmp = \`${'${configPath()}'}${'.tmp'}\`;
\ttry {
\t\tconst normalized = normalizeConfig(config);
\t\twarnUnknownConfigKeys(config, normalized);
\t\tawait writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
\t\tawait rename(tmp, configPath());
\t\tdropConfigCache();
\t\treturn true;
\t} catch (e) {
\t\tconsole.error(\`dsh-any-background: failed to write "${'${CONFIG_FILE}'}"\`, e);
\t\ttry {
\t\t\tawait rm(tmp, { force: true });
\t\t} catch {}
\t\treturn false;
\t}
}`

const PATCHED_WRITE_CONFIG = `async function writeConfig(config) {
\tconst path = configPath();
\tconst previous = __dshAppearanceWriteTails.get(path) ?? Promise.resolve();
\tconst next = previous.catch(() => undefined).then(async () => {
\t\ttry {
\t\t\tawait ensureDir();
\t\t\tconst normalized = normalizeConfig(config);
\t\t\twarnUnknownConfigKeys(config, normalized);
\t\t\tawait withFileLock(path, () => writeFileAtomic(path, JSON.stringify(normalized, null, 2), { mode: 0o600 }));
\t\t\tdropConfigCache();
\t\t\treturn true;
\t\t} catch (e) {
\t\t\tconsole.error(\`dsh-any-background: failed to write "${'${CONFIG_FILE}'}"\`, e);
\t\t\treturn false;
\t\t}
\t});
\t__dshAppearanceWriteTails.set(path, next);
\treturn next.finally(() => {
\t\tif (__dshAppearanceWriteTails.get(path) === next) __dshAppearanceWriteTails.delete(path);
\t});
}`

const PRELUDE = `import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
const __dshAppearanceWriteTails = new Map();
function __dshAppearanceActualDshAnchor(ctx) {
  return ctx.profileContext?.resolvePackageManifest?.("@deepseek-ai/dsh") ?? ctx.profileContext?.installAnchor;
}`

const STOCK_HOST_INFO_CALL = 'resolveHostInfo(ctx.profileContext?.installAnchor)'
const PATCHED_HOST_INFO_CALL = 'resolveHostInfo(__dshAppearanceActualDshAnchor(ctx))'

function sourceText(source: ModuleSource): string {
  if (typeof source === 'string') return source
  if (source instanceof ArrayBuffer) return Buffer.from(source).toString('utf8')
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
}

function isWithin(directory: string, candidate: string): boolean {
  const offset = relative(directory, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function hasExpectedManifest(modulePath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(modulePath)), 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    return manifest.name === PACKAGE_NAME && manifest.version === PACKAGE_VERSION
  } catch {
    return false
  }
}

/** Return transformed source only for the exact known dsh-any-background 0.3.9 bundle. */
export function patchAppearancePluginSource(
  modulePath: string,
  profileDirectory: string,
  source: ModuleSource,
): string | undefined {
  if (basename(modulePath) !== 'index.js' || !modulePath.endsWith(MODULE_SUFFIX)
    || !isWithin(profileDirectory, modulePath) || !hasExpectedManifest(modulePath)) return undefined
  const text = sourceText(source)
  const stockWriter = text.includes(STOCK_WRITE_CONFIG)
    ? STOCK_WRITE_CONFIG
    : STOCK_WRITE_CONFIG.replaceAll('\n', '\r\n')
  if (createHash('sha256').update(text).digest('hex') !== SOURCE_SHA256
    || !text.includes(stockWriter)) return undefined
  const patchedWriter = stockWriter === STOCK_WRITE_CONFIG
    ? PATCHED_WRITE_CONFIG
    : PATCHED_WRITE_CONFIG.replaceAll('\n', '\r\n')
  return `${PRELUDE}\n${text.replace(stockWriter, patchedWriter).replace(STOCK_HOST_INFO_CALL, PATCHED_HOST_INFO_CALL)}`
}
