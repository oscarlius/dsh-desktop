import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { request } from 'node:http'
import { dirname } from 'node:path'

/** Official-core browser cookie plus its absolute expiry (`0` when the Set-Cookie carried none). */
export interface StoredCoreCookie { cookie: string; expiresAt: number }

export const CORE_COOKIE_FILE = '/run/p7-web-state/core-cookie.json'
/** Renew this long before the recorded expiry so controller polls never receive an about-to-expire cookie. */
export const RENEW_MARGIN_MS = 60 * 60 * 1000
const MAX_STATE_BYTES = 16_384

/** Read the Expires/Max-Age lifetime of one Set-Cookie header; `0` marks an unknown lifetime. */
export function parseSetCookieExpiry(header: string, now = Date.now()): number {
  const expires = /(?:^|;\s*)expires=([^;]+)/i.exec(header)?.[1]
  if (expires) { const parsed = Date.parse(expires.trim()); if (Number.isFinite(parsed)) return parsed }
  const maxAge = /(?:^|;\s*)max-age=(\d+)/i.exec(header)?.[1]
  return maxAge ? now + Number(maxAge) * 1000 : 0
}

/** Read the stored cookie; a corrupt or oversized state file is treated as absent so the broker renews. */
export async function readStoredCoreCookie(file = CORE_COOKIE_FILE): Promise<StoredCoreCookie | undefined> {
  try {
    const raw = await readFile(file, 'utf8')
    if (raw.length > MAX_STATE_BYTES) return undefined
    const value = JSON.parse(raw) as { cookie?: unknown; expiresAt?: unknown }
    if (typeof value.cookie !== 'string' || value.cookie.length === 0 || /[\r\n]/.test(value.cookie)) return undefined
    const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) && value.expiresAt >= 0 ? value.expiresAt : 0
    return { cookie: value.cookie, expiresAt }
  } catch { return undefined }
}

export async function writeStoredCoreCookie(value: StoredCoreCookie, file = CORE_COOKIE_FILE): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

/**
 * Exchange the official launch token for the authority-bound browser cookie by
 * dialing the private listener while presenting the public Host. The official
 * launch token stays valid for the process lifetime, so callers repeat this
 * exchange to renew an expiring cookie without restarting the container.
 */
export function exchangeLaunchToken(upstream: URL, authority: string, token: string): Promise<StoredCoreCookie> {
  const publicUrl = new URL(`http://${authority}/?token=${encodeURIComponent(token)}`)
  return new Promise((resolve, reject) => {
    const req = request(publicUrl, {
      // Preserve the public Host for the official server while dialing its private listener.
      createConnection: () => connect({ host: upstream.hostname, port: Number(upstream.port || 80) }),
    }, response => {
      const setCookie = response.headers['set-cookie']?.[0]; response.resume()
      const cookie = setCookie?.split(';', 1)[0]
      if ((response.statusCode !== 302 && response.statusCode !== 303) || !cookie) reject(new Error('official web token exchange failed'))
      else resolve({ cookie, expiresAt: parseSetCookieExpiry(setCookie) })
    })
    req.on('error', reject); req.end()
  })
}
