/**
 * P7-gateway-backed `WebSearchProvider` plugin. It contributes the provider id `p7`
 * to the `ctx.web` registry without owning the service, and reuses the connection the
 * P7 company-model plugin already established for this Profile: the same
 * profile-derived credential reference for the gateway access key, and the same
 * persisted origin. The sealed Company Desktop profile selects it; ordinary
 * Desktop profiles retain their existing default selection.
 *
 * @module dsh-plugin-p7-web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-web'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  p7CredentialRef,
  P7_DEFAULT_ORIGIN,
  P7_DEFAULT_REQUEST_TIMEOUT_MS,
  P7_PERSISTENCE_FILE,
  P7ConnectionResolver,
} from './connection.js'
import { P7SearchProvider } from './provider.js'

export {
  P7ConnectionResolver,
  p7CredentialRef,
  P7_DEFAULT_ORIGIN,
  P7_DEFAULT_REQUEST_TIMEOUT_MS,
  P7_MAX_ERROR_BODY_BYTES,
  P7_MAX_RESPONSE_BYTES,
  P7_PERSISTENCE_FILE,
  P7_PROVIDER_ID,
  P7_WEB_SEARCH_PATH,
  isValidP7Origin,
  normalizeP7Origin,
  readPersistedP7Origin,
} from './connection.js'
export type { P7ConnectionSources, P7CredentialReader, P7ResolvedConnection } from './connection.js'
export {
  mapP7Response,
  mapP7Source,
  P7SearchProvider,
} from './provider.js'
export type { P7SearchProviderOptions, P7Fetch } from './provider.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-p7'

/** The web seam this provider registers into, plus the two planes holding its connection. */
export const inject = ['web', 'credentials', 'profileContext']

/** Plugin config (all optional — `apply` fills the Profile, credential, and environment layers). */
export interface Config {
  /** Gateway origin. Falls back to this Profile's persisted P7 origin, then {@link P7_DEFAULT_ORIGIN}. */
  origin?: string
  /** Literal gateway access key. Prefer `credentialRef`; never logged and never echoed back. */
  apiKey?: string
  /** Credential reference to resolve. Defaults to the profile-derived `P7_DSH_<hash>_API_KEY`. */
  credentialRef?: string
  /**
   * Documented client-side ceiling on returned sources. It is NOT sent to the
   * gateway: `pageno` is a page number, not a count, and the seam enforces a
   * request's own `maxResults` on the way back.
   */
  maxResults?: number
  /** Deadline for one request including body reading. Defaults to 10000 ms. */
  requestTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  origin: z.string(),
  // Secret role: a settings surface renders this section, so the value must be
  // declared as a secret rather than merely treated as one at the use site.
  apiKey: z.string().role('secret'),
  credentialRef: z.string(),
  maxResults: z.number().step(1).min(1),
  requestTimeoutMs: z.number().step(1).min(1),
})

/** Register the P7 search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const ref = credentialRef(config.credentialRef ?? p7CredentialRef(ctx.profileContext.dir))
  const resolver = new P7ConnectionResolver({
    credentialRef: ref,
    credentials: ctx.credentials,
    persistenceFile: join(ctx.profileContext.dir, P7_PERSISTENCE_FILE),
    ambientApiKey: () => launchEnvironmentOf(ctx).get(ref)?.value,
    requestTimeoutMs: config.requestTimeoutMs ?? P7_DEFAULT_REQUEST_TIMEOUT_MS,
    ...config.origin === undefined ? {} : { configuredOrigin: config.origin },
    ...config.apiKey === undefined || config.apiKey.length === 0 ? {} : { configuredApiKey: config.apiKey },
    ...config.maxResults === undefined ? {} : { maxResults: config.maxResults },
  })
  const provider = new P7SearchProvider({
    // The resolver, not a snapshot: the credential plane is re-read for each
    // search, so a key P7 rotates mid-session reaches the next one.
    connection: resolver,
    credentialRef: ref,
  })
  ctx.web.registerSearchProvider(provider)
  // CompanyHost writes the shared profile-derived reference after Loader
  // startup. Re-read it whenever the credential owner commits a rotation,
  // bootstrap connection, or disconnect; `resolve()` waits for this refresh so
  // a just-committed company connection can serve the first search.
  ctx.on('credentials/reference-updated', updatedRef => {
    if (updatedRef === ref) void resolver.refresh()
  })
  // Registration is synchronous, but the Profile snapshot and the credential
  // plane are not. The Company profile is selected only after its shared
  // credential is committed; ordinary profiles keep their original selection.
  void resolver.settling.then(() => {
    if (provider.available()) return
    ctx.logger.debug(`P7 web search is registered but not usable: no HTTPS origin verified, or no access key resolved for "${ref}"`)
  }, () => undefined)
}
