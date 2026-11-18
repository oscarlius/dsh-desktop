import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { controllerPeerAllowed, readControllerToken } from './controller-route.js'
import { timingSafeEqual } from 'node:crypto'
import { CORE_COOKIE_FILE, RENEW_MARGIN_MS, readStoredCoreCookie, writeStoredCoreCookie, type StoredCoreCookie } from './core-cookie.js'

const PATH = '/p7-web-host/internal/bootstrap'
function reply(res: ServerResponse, status: number, value: unknown): void { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff'); res.end(JSON.stringify(value)) }
function authorized(req: IncomingMessage): boolean { const token = readControllerToken(); const value = req.headers['x-p7-controller-token']; if (!token || !controllerPeerAllowed(req.socket.remoteAddress) || typeof value !== 'string') return false; const supplied = Buffer.from(value); return supplied.length === token.length && timingSafeEqual(supplied, token) }

/** Controller-facing cookie source: serves the launcher-exchanged cookie and renews it before expiry. */
export interface CoreCookieBroker { getCookie(): Promise<string | undefined> }

export function createCoreCookieBroker(options: { mint(): Promise<StoredCoreCookie>; file?: string; now?(): number }): CoreCookieBroker {
  const file = options.file ?? CORE_COOKIE_FILE
  const now = () => options.now?.() ?? Date.now()
  let pending: Promise<string | undefined> | undefined
  const load = async (): Promise<string | undefined> => {
    const stored = await readStoredCoreCookie(file)
    // A recorded expiry inside the margin, or none at all, renews through the launch token.
    if (stored && stored.expiresAt > now() + RENEW_MARGIN_MS) return stored.cookie
    try {
      const minted = await options.mint()
      await writeStoredCoreCookie(minted, file)
      return minted.cookie
    } catch { return undefined }
  }
  return { getCookie() { pending ??= load().finally(() => { pending = undefined }); return pending } }
}

export function registerBootstrapRoute(server: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void }, broker: CoreCookieBroker): () => void { return server.register({ kind: 'exact', path: PATH, async handler(req, res) { if (req.method !== 'GET') { res.setHeader('allow', 'GET'); reply(res, 405, { error: 'Method not allowed.' }); return }; if (!authorized(req)) { reply(res, 503, { error: 'Unavailable.' }); return }; const value = await broker.getCookie(); if (!value) { reply(res, 503, { state: 'unknown' }); return }; reply(res, 200, { cookie: value }) } }) }
export { PATH as BOOTSTRAP_PATH }
