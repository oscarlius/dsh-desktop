/** A generation-scoped capability for Host HTTP calls back into its own server. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export const HOST_SELF_ACCESS_HEADER = 'x-dsh-desktop-host-self'

const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export interface HostSelfAccess {
  readonly token: string
}

export function createHostSelfAccess(token = randomBytes(TOKEN_BYTES).toString('base64url')): HostSelfAccess {
  if (!TOKEN_PATTERN.test(token)) throw new TypeError('dsh-plugin-desktop: host self-access token must be 32 base64url bytes')
  return Object.freeze({ token })
}

export function hasHostSelfAccess(headers: IncomingHttpHeaders, access: HostSelfAccess | undefined): boolean {
  const actual = headers[HOST_SELF_ACCESS_HEADER]
  if (access === undefined || typeof actual !== 'string' || !TOKEN_PATTERN.test(actual) || actual.length !== access.token.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(access.token))
}

function initialRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.href
  return input
}

function targetsOrigin(input: RequestInfo | URL, origin: string): boolean {
  try {
    return new URL(initialRequestUrl(input)).origin === origin
  } catch {
    return false
  }
}

/**
 * Authenticate only explicit Host fetches to this exact listener origin.
 *
 * Redirects from the listener fail closed unless the caller has explicitly
 * selected manual handling, so this capability never follows a redirect.
 */
export function installHostSelfFetch(origin: string, access: HostSelfAccess): () => void {
  const capturedFetch = globalThis.fetch
  let active = true

  const wrappedFetch: typeof fetch = async (input, init) => {
    if (!active) return capturedFetch(input, init)

    if (!targetsOrigin(input, origin)) return capturedFetch(input, init)

    const request = new Request(input, init)

    const headers = new Headers(request.headers)
    headers.set(HOST_SELF_ACCESS_HEADER, access.token)
    const redirect = request.redirect === 'manual' ? 'manual' : 'error'
    return capturedFetch(new Request(request, { headers, redirect }))
  }

  globalThis.fetch = wrappedFetch
  return () => {
    active = false
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = capturedFetch
  }
}
