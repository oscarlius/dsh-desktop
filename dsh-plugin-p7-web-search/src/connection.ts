/**
 * Connection layers for the P7 gateway: the origin planes (config, the Profile
 * snapshot the P7 company-model plugin maintains, then the documented default),
 * the access-key planes (config, the credential service, then the launch
 * environment), and the origin validator the tested P7 desktop config client
 * already enforces. Nothing here touches the network, and no layer returns a
 * secret to a caller that did not ask for one.
 * @module dsh-plugin-p7-web-search/connection
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Stable id this provider registers under; `web.searchProvider: p7` selects it. */
export const P7_PROVIDER_ID = 'p7'

/** Gateway operation this provider calls, appended to the resolved origin. */
export const P7_WEB_SEARCH_PATH = '/v1/desktop/web-search'

/**
 * Documented default origin, the same public P7 service the company-model plugin
 * bootstraps against. A deployment behind a different gateway sets `origin`.
 */
export const P7_DEFAULT_ORIGIN = 'https://maas.zxrc.com.cn:8090'

/** Request deadline, including body reading. Mirrors the tested P7 config client. */
export const P7_DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/** Response ceiling for a search page. Mirrors `MAX_RESPONSE_BYTES` in the P7 config client. */
export const P7_MAX_RESPONSE_BYTES = 256 * 1024

/** Ceiling for a failure body, which is a code and a message — never a catalog. */
export const P7_MAX_ERROR_BODY_BYTES = 16 * 1024

/**
 * Persistence file the P7 company-model plugin owns inside the active Profile.
 * This plugin reads one field of it (`origin`); it never writes it.
 */
export const P7_PERSISTENCE_FILE = '.p7-company-models.json'

/** Bound on that file's read, so a stray large file never reaches `JSON.parse`. */
const MAX_PERSISTED_BYTES = 300 * 1024

/**
 * The credential reference the P7 company-model plugin stores its gateway key
 * under for one Profile. Derived, never configured, and the same for both
 * plugins because both address one Profile's P7 connection.
 * @param profileId - the active Profile directory (`ctx.profileContext.dir`).
 * @returns the reference name, which is also its environment-variable name.
 */
export function p7CredentialRef(profileId: string): string {
  return 'P7_DSH_' + createHash('sha256').update(profileId).digest('hex').slice(0, 24).toUpperCase() + '_API_KEY'
}

/**
 * Mirror of `validateP7Origin` in dsh-plugin-p7-company-models/src/p7-client.ts:
 * HTTPS, no embedded credentials, no query, no fragment, and a `/` pathname.
 * @param input - candidate origin.
 * @returns the normalized origin, or `undefined` when the candidate is unsafe.
 */
export function normalizeP7Origin(input: string): string | undefined {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0 || url.pathname !== '/') return undefined
  return url.origin
}

/**
 * Cheap local origin check used by {@link P7SearchProvider.available}.
 * @param input - candidate origin.
 * @returns true when {@link normalizeP7Origin} would accept it.
 */
export function isValidP7Origin(input: string): boolean {
  return normalizeP7Origin(input) !== undefined
}

/**
 * Read only the `origin` the P7 company-model plugin already persisted. Absent,
 * unreadable, oversized, corrupt, or a `null` origin all read as "no snapshot",
 * and no file content is ever surfaced — the file also holds a model catalog.
 * @param path - the Profile-relative persistence file.
 * @returns the persisted origin, or `undefined`.
 */
export async function readPersistedP7Origin(path: string): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > MAX_PERSISTED_BYTES) return undefined
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const origin = (raw as { origin?: unknown }).origin
    return typeof origin === 'string' ? normalizeP7Origin(origin) : undefined
  } catch {
    return undefined
  }
}

/** How the credential plane is read: the shape `ctx.credentials` supplies. */
export interface P7CredentialReader {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
}
/** The cross-bundle Host account face stored under the profile registry Symbol. */
interface RegisteredP7Account { usesPersonalToken(): boolean; getValidAccessToken(): Promise<string> }
const ACCOUNT_REGISTRY = Symbol.for('dsh.p7.account-broker.registry')
function registeredAccount(profileId: string | undefined): RegisteredP7Account | undefined {
  if (profileId === undefined) return undefined
  const host = globalThis as typeof globalThis & { [ACCOUNT_REGISTRY]?: Map<string, RegisteredP7Account> }
  return host[ACCOUNT_REGISTRY]?.get(profileId)
}

/** The fully resolved connection one search is served with. */
export interface P7ResolvedConnection {
  /** Normalized HTTPS origin, or the invalid value a user configured so diagnostics can name it. */
  readonly origin: string
  /** Gateway access key. Never logged, never echoed into an error message. */
  readonly apiKey: string
  /** Deadline for the whole operation, including response-body reading. */
  readonly requestTimeoutMs: number
  /**
   * Documented client-side ceiling. It is NOT transmitted: the contract's only
   * paging knob is `pageno`, a page number, and the seam enforces a request's own
   * `maxResults`. It bounds what this provider hands back.
   */
  readonly maxResults?: number
}

/** Configuration planes `apply` hands to the resolver, most trusted first. */
export interface P7ConnectionSources {
  /** Profile id binds this resolver to the Host's personal-account registry. */
  readonly profileId?: string
  /** Literal origin from config; wins over the Profile snapshot and the default. */
  readonly configuredOrigin?: string
  /** Literal key from config; wins over every credential layer. */
  readonly configuredApiKey?: string
  /** Reference resolved through the credential plane for each operation. */
  readonly credentialRef: CredentialRef
  /** Credential plane; `undefined` only in compositions that did not mount it. */
  readonly credentials?: P7CredentialReader
  /** Host-only personal-account source. When selected, legacy shared keys are forbidden. */
  readonly personalAccessToken?: () => Promise<string | undefined>
  /** `undefined` means no scoped broker is currently available. */
  readonly usesPersonalToken?: () => boolean | undefined
  /** A scoped broker was observed, so do not read a registry entry being disposed. */
  readonly personalAccountKnown?: () => boolean
  /** Same reference read from the launch environment, synchronously. */
  ambientApiKey(): string | undefined
  /** Profile file whose `origin` field the P7 company-model plugin maintains. */
  readonly persistenceFile: string
  readonly requestTimeoutMs: number
  readonly maxResults?: number
}

/**
 * One Profile's P7 connection, read from its layers and kept current.
 *
 * Two views by design. {@link peek} is synchronous and reads cached slots,
 * because the seam's `available()` must be a cheap local check with no network.
 * {@link resolve} is per operation, because a rotated access key has to reach the
 * next search without remounting the plugin.
 */
export class P7ConnectionResolver {
  private origin: string
  private apiKey: string
  private refreshing: Promise<void> = Promise.resolve()
  private pendingCredentialRefreshes = 0
  private settlingPending = true
  private availabilityBlocked = false
  private availabilityGeneration = 0
  private personalModeSeen = false
  /** The activation-time read of the Profile snapshot and the credential plane. */
  readonly settling: Promise<void>

  constructor(private readonly sources: P7ConnectionSources) {
    const configured = sources.configuredOrigin
    // An explicitly configured origin is never quietly replaced by the default:
    // a typo must read as unavailable, not as a silently different gateway.
    this.origin = configured === undefined || configured.length === 0
      ? P7_DEFAULT_ORIGIN
      : normalizeP7Origin(configured) ?? configured
    this.apiKey = syncKey(sources)
    this.settling = this.settle().finally(() => { this.settlingPending = false })
  }

  /** Synchronous view for `available()`; performs no IO. */
  peek(): P7ResolvedConnection {
    return {
      origin: this.origin,
      apiKey: this.apiKey,
      requestTimeoutMs: this.sources.requestTimeoutMs,
      ...this.sources.maxResults === undefined ? {} : { maxResults: this.sources.maxResults },
    }
  }

  /**
   * The connection for one operation. Waits for the activation-time snapshot read
   * so a search never posts to the default origin while the Profile's own gateway
   * is still being read, then re-reads the credential.
   */
  async resolve(): Promise<P7ResolvedConnection> {
    await this.settling
    await this.refreshing
    const generation = this.availabilityGeneration
    await this.refreshOrigin()
    const apiKey = await this.readKey()
    if (generation !== this.availabilityGeneration) return { ...this.peek(), apiKey: '' }
    this.apiKey = apiKey
    return { ...this.peek(), apiKey }
  }

  /**
   * Re-read the credential after its owning P7 connection commits a change.
   * Credential notifications are synchronous dispatches but listeners are not
   * awaited by that service, so searches wait for this promise in `resolve()`.
   */
  refresh(): Promise<void> {
    this.pendingCredentialRefreshes += 1
    const generation = this.availabilityGeneration
    const refresh = this.refreshing.then(async () => {
      await this.refreshOrigin()
      const apiKey = await this.readKey()
      if (generation === this.availabilityGeneration) {
        this.apiKey = apiKey
        this.availabilityBlocked = false
      }
    })
    this.refreshing = refresh.catch(() => {
      if (generation === this.availabilityGeneration) this.apiKey = ''
    }).finally(() => {
      this.pendingCredentialRefreshes -= 1
    })
    return this.refreshing
  }

  /** Clear the cached key before an account-state refresh completes. */
  invalidate(): void {
    this.availabilityGeneration += 1
    this.apiKey = ''
    this.availabilityBlocked = true
  }

  /** Whether a committed credential update is still being reflected locally. */
  hasPendingCredentialRefresh(): boolean {
    return !this.availabilityBlocked && (this.settlingPending || this.pendingCredentialRefreshes > 0)
  }

  private async settle(): Promise<void> {
    const generation = this.availabilityGeneration
    try {
      await this.refreshOrigin()
      const apiKey = await this.readKey()
      if (generation === this.availabilityGeneration) this.apiKey = apiKey
    } catch {
      // Unresolved rather than broken: `available()` then reports false, which is
      // honest, instead of dispatching a search that cannot authenticate.
    }
  }

  /** Keep the shared CompanyHost origin current across reconnects and disconnects. */
  private async refreshOrigin(): Promise<void> {
    if (this.sources.configuredOrigin !== undefined && this.sources.configuredOrigin.length > 0) return
    this.origin = await readPersistedP7Origin(this.sources.persistenceFile) ?? P7_DEFAULT_ORIGIN
  }

  private async readKey(): Promise<string> {
    const scopedMode = this.sources.usesPersonalToken?.()
    const account = scopedMode === undefined && this.sources.personalAccountKnown?.() !== true
      ? registeredAccount(this.sources.profileId)
      : undefined
    const personalMode = account?.usesPersonalToken() ?? scopedMode
    if (personalMode === true) {
      this.personalModeSeen = true
      try { return (await (account?.getValidAccessToken() ?? this.sources.personalAccessToken?.()))?.trim() ?? '' } catch { return '' }
    }
    if (personalMode === false) this.personalModeSeen = false
    if (this.personalModeSeen) return ''
    const literal = this.sources.configuredApiKey?.trim() ?? ''
    if (literal.length > 0) return literal
    const { credentials, credentialRef } = this.sources
    if (credentials !== undefined) {
      try {
        const stored = (await credentials.resolve(credentialRef))?.value.trim() ?? ''
        if (stored.length > 0) return stored
      } catch {
        // A credential plane that fails reads as unconfigured, then falls through
        // to the environment. The reference name is the whole diagnostic; the
        // value never appears here.
      }
    }
    return this.sources.ambientApiKey()?.trim() ?? ''
  }
}

/** The key visible without any await: a literal config value, then the launch environment. */
function syncKey(sources: P7ConnectionSources): string {
  const literal = sources.configuredApiKey?.trim() ?? ''
  if (literal.length > 0) return literal
  return sources.ambientApiKey()?.trim() ?? ''
}
