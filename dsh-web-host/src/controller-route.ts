import { readFileSync, statSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebActivityProbe } from './activity.js'

const TOKEN_FILE = '/run/p7-web/controller.token'
const PATH = '/p7-web-host/internal/activity'
const READY_PATH = '/p7-web-host/internal/ready'

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(value))
}

/** Read a private controller token; failure leaves the route fail-closed. */
export function readControllerToken(path = TOKEN_FILE): Buffer | undefined {
  try {
    if (path !== TOKEN_FILE) throw new Error('invalid controller token path')
    const stat = statSync(path)
    if (!stat.isFile() || stat.size < 32 || stat.size > 512 || (stat.mode & 0o077) !== 0) throw new Error('unsafe controller token')
    const token = Buffer.from(readFileSync(path, 'utf8').trim(), 'utf8')
    return token.length >= 32 ? token : undefined
  } catch { return undefined }
}

/**
 * The controller peer is an exact address, not a broad private range.  A
 * rootless bridge may make this the bridge gateway rather than loopback.
 */
export function controllerPeerAllowed(remoteAddress: string | undefined, configured = process.env.P7_WEB_CONTROLLER_PEER ?? '127.0.0.1'): boolean {
  return Boolean(remoteAddress && isIP(configured) !== 0 && remoteAddress === configured)
}

function authorized(req: IncomingMessage, token: Buffer | undefined): boolean {
  if (!token || !controllerPeerAllowed(req.socket.remoteAddress)) return false
  const supplied = req.headers['x-p7-controller-token']
  if (typeof supplied !== 'string') return false
  const candidate = Buffer.from(supplied, 'utf8')
  return candidate.length === token.length && timingSafeEqual(candidate, token)
}

export function registerControllerActivityRoute(server: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void }): () => void }, activity: WebActivityProbe): () => void {
  const routes = [PATH, READY_PATH].map(path => server.register({ kind: 'exact', path, async handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); reply(res, 405, { error: 'Method not allowed.' }); return }
    if (!authorized(req, readControllerToken())) { reply(res, 503, { state: 'unknown' }); return }
    const snapshot = await activity.inspect()
    reply(res, 200, path === READY_PATH ? { ready: true, activity: snapshot } : snapshot)
  } }))
  return () => { for (const dispose of routes.reverse()) dispose() }
}

export { PATH as CONTROLLER_ACTIVITY_PATH, READY_PATH as CONTROLLER_READY_PATH }
