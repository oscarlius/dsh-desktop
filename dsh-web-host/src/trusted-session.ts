import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { WebRequestTrust } from './web-account.js'

const ATTESTATION_KEY_FILE = '/run/p7-web/attestation.key'
const MAX_ATTESTATION_AGE_MS = 60_000

export interface P7WebTrustedSessionConfig { publicOrigin: string }

function secret(): Buffer | undefined {
  try {
    const metadata = statSync(ATTESTATION_KEY_FILE)
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 4096 || (metadata.mode & 0o077) !== 0) return undefined
    const value = Buffer.from(readFileSync(ATTESTATION_KEY_FILE, 'utf8').trim(), 'utf8')
    return value.length >= 32 ? value : undefined
  } catch { return undefined }
}

function text(value: string | string[] | undefined): string | undefined { return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined }
function signature(secret: Buffer, req: IncomingMessage, employee: string, instance: string, generation: string, expires: string): Buffer {
  return createHmac('sha256', secret).update([req.method ?? '', req.url ?? '', employee, instance, generation, expires].join('\n')).digest()
}

/**
 * Verifies attestations added by the authenticated P7 edge. Browser clients do
 * not possess this key and direct requests fail closed. The attestation binds
 * one request to employee, instance, and generation, so an old container cannot
 * retain access after a controller generation changes.
 */
export class HeaderTrustedSession implements WebRequestTrust {
  isTrustedRequest(req: IncomingMessage): boolean {
    const key = secret()
    const employee = text(req.headers['x-p7-web-employee'])
    const instance = text(req.headers['x-p7-web-instance'])
    const generation = text(req.headers['x-p7-web-generation'])
    const expires = text(req.headers['x-p7-web-expires'])
    const supplied = text(req.headers['x-p7-web-signature'])
    if (!key || !employee || !instance || !generation || !expires || !supplied || !/^\d{13}$/.test(expires)) return false
    const expiry = Number(expires)
    if (!Number.isSafeInteger(expiry) || expiry < Date.now() || expiry > Date.now() + MAX_ATTESTATION_AGE_MS) return false
    const actual = signature(key, req, employee, instance, generation, expires)
    let candidate: Buffer
    try { candidate = Buffer.from(supplied, 'base64url') } catch { return false }
    return candidate.length === actual.length && timingSafeEqual(candidate, actual)
  }
}

declare module '@deepseek-ai/cordis' { interface Context { p7WebTrustedSession?: WebRequestTrust } }

export const name = 'dsh-web-trusted-session'
export interface Config extends P7WebTrustedSessionConfig {}
export function apply(ctx: Context, config: Config): void {
  const origin = new URL(config.publicOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) throw new Error('P7 Web trusted-session requires one exact HTTPS public origin.')
  ctx.provide('p7WebTrustedSession', new HeaderTrustedSession())
}
