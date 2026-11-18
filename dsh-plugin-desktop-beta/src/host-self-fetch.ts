/** A generation-scoped capability for Host HTTP calls back into its own server. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export const HOST_SELF_ACCESS_HEADER = 'x-dsh-desktop-host-self'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
export interface HostSelfAccess { readonly token: string }
export function createHostSelfAccess(token = randomBytes(32).toString('base64url')): HostSelfAccess {
  if (!TOKEN_PATTERN.test(token)) throw new TypeError('dsh-plugin-desktop: host self-access token must be 32 base64url bytes')
  return Object.freeze({ token })
}
export function hasHostSelfAccess(headers: IncomingHttpHeaders, access: HostSelfAccess | undefined): boolean {
  const actual = headers[HOST_SELF_ACCESS_HEADER]
  return access !== undefined && typeof actual === 'string' && TOKEN_PATTERN.test(actual) && actual.length === access.token.length && timingSafeEqual(Buffer.from(actual), Buffer.from(access.token))
}
export function installHostSelfFetch(origin: string, access: HostSelfAccess): () => void {
  const captured = globalThis.fetch; let active = true
  const wrapped: typeof fetch = async (input, init) => {
    if (!active) return captured(input, init)
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    let exact = false; try { exact = new URL(url).origin === origin } catch { /* normal fetch reports invalid URLs */ }
    if (!exact) return captured(input, init)
    const request = new Request(input, init); const headers = new Headers(request.headers); headers.set(HOST_SELF_ACCESS_HEADER, access.token)
    return captured(new Request(request, { headers, redirect: request.redirect === 'manual' ? 'manual' : 'error' }))
  }
  globalThis.fetch = wrapped
  return () => { active = false; if (globalThis.fetch === wrapped) globalThis.fetch = captured }
}
