import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { P7AccountFactory, P7AccountFactoryOptions } from 'dsh-plugin-p7-company-models'
import type { P7AccountProfile, P7AccountService, P7AccountStatus, P7Usage } from 'dsh-plugin-p7-company-models'

/** A controller-issued workload credential, never a browser session credential. */
export interface WebAccountFile { origin: string; instanceToken: string; expiresAt: number; tokenType: 'Bearer'; profile: P7AccountProfile; instanceId?: string; generation?: number }
export interface WebAccountOptions { publicOrigin: string; now?(): number }

const DEFAULT_ACCOUNT_FILE = '/run/p7-web/instance.json'
const MAX_ACCOUNT_BYTES = 16_384

/** Read only the controller-owned, per-container account mount. */
export async function readPrivateWebAccount(path = DEFAULT_ACCOUNT_FILE, expectedOrigin?: string): Promise<WebAccountFile | undefined> {
  if (path !== DEFAULT_ACCOUNT_FILE) throw new Error('Web account file must use the controller-owned mount.')
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size > MAX_ACCOUNT_BYTES || (metadata.mode & 0o077) !== 0) throw new Error('unsafe account file')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    const account = parsePrivateWebAccount(value, expectedOrigin)
    if (!account) throw new Error('invalid account file')
    return account
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('The controller account could not be read.')
  }
}

/** Server-only account broker for the Web container.  It never starts a callback listener or revokes portal sessions. */
export class WebAccountBroker implements P7AccountService {
  private account: WebAccountFile | undefined
  private phase: P7AccountStatus['phase'] = 'signed-out'
  private message: string | null = null
  private binding: string | undefined
  private readonly listeners = new Set<(status: P7AccountStatus) => void>()
  constructor(private readonly options: WebAccountOptions, private readonly load = () => readPrivateWebAccount(undefined, options.publicOrigin)) {}
  status(): P7AccountStatus { return { phase: this.phase, profile: this.account?.profile ?? null, expiresAt: this.account?.expiresAt ?? null, authorizationUrl: this.phase === 'pending' ? this.portalUrl() : null, upgradeUrl: null, message: this.message } }
  connection() { return { origin: this.options.publicOrigin, getValidAccessToken: () => this.getValidAccessToken(), usesPersonalToken: () => true } }
  usesPersonalToken(): boolean { return true }
  setPersonalMode(_value: boolean): void { /* Web identity is always controller-owned. */ }
  subscribe(listener: (status: P7AccountStatus) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async restore(): Promise<void> {
    try {
      const account = await this.load()
      if (account && !this.acceptBinding(account)) throw new Error('controller identity changed')
      this.account = account
      this.phase = account ? 'signed-in' : 'signed-out'
      this.message = null
    } catch { this.account = undefined; this.phase = 'error'; this.message = 'The controller account is unavailable.' }
    this.publish()
  }
  /** Web login belongs to the authenticated edge; never open a loopback callback. */
  async login(): Promise<P7AccountStatus> { await this.restore(); return this.status() }
  async logout(): Promise<void> { this.account = undefined; this.binding = undefined; this.phase = 'signed-out'; this.message = null; this.publish() }
  async getValidAccessToken(): Promise<string> {
    // The BFF atomically replaces this file for every workload-token renewal.
    // Never keep a former instance credential beyond an individual request.
    let account: WebAccountFile
    try {
      const loaded = await this.load()
      if (!loaded || !this.acceptBinding(loaded)) throw new Error('controller identity unavailable')
      account = loaded
    } catch {
      this.clear('The controller account is unavailable.')
      throw new Error('P7 personal sign-in is required.')
    }
    if (account.expiresAt <= this.now() + 60_000) {
      this.clear('Your Web workload credential expired. Reload through the company portal.')
      throw new Error('P7 Web workload credential expired.')
    }
    this.account = account
    this.phase = 'signed-in'; this.message = null
    return account.instanceToken
  }
  async usage(from: string, to: string, groupBy: 'day' | 'model' | 'service' = 'day'): Promise<P7Usage> {
    const token = await this.getValidAccessToken()
    const response = await fetch(`${this.options.publicOrigin}/api/v1/web-auth/usage?${new URLSearchParams({ from, to, groupBy })}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, redirect: 'error' })
    if (!response.ok) { this.clear('Your company sign-in expired. Sign in again.'); throw new Error('P7 usage is unavailable.') }
    return await response.json() as P7Usage
  }
  async dispose(): Promise<void> { this.account = undefined; this.listeners.clear() }
  private clear(message: string): void {
    if (this.phase === 'expired' && this.message === message) return
    this.account = undefined
    this.phase = 'expired'; this.message = message
    this.publish()
  }
  private acceptBinding(account: WebAccountFile): boolean {
    const binding = `${account.origin}\n${account.profile.organizationId}\n${account.profile.userId}\n${account.instanceId ?? ''}\n${account.generation ?? ''}`
    if (this.binding && this.binding !== binding) return false
    this.binding = binding
    return true
  }
  private portalUrl(): string { return this.options.publicOrigin }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private publish(): void { const status = this.status(); for (const listener of this.listeners) listener(status) }
}

export function createWebAccountFactory(options: WebAccountOptions): P7AccountFactory { return { create(_options: P7AccountFactoryOptions): P7AccountService { return new WebAccountBroker(options) } } }
export interface WebRequestTrust { isTrustedRequest(req: IncomingMessage): boolean }
export function webRouteAdmission(publicOrigin: string, trust: WebRequestTrust) { return { publicOrigin: () => publicOrigin, isTrustedRequest: (req: IncomingMessage) => trust.isTrustedRequest(req) } }

export function parsePrivateWebAccount(value: unknown, expectedOrigin?: string): WebAccountFile | undefined {
  try {
    const record = object(value); const origin = text(record.origin); const instanceToken = text(record.accessToken) ?? text(record.instanceToken)
    const expiresAt = timestamp(record.expiresAt); const profile = profileOf(record.profile)
    if (!origin || !instanceToken || expiresAt === undefined || record.tokenType !== 'Bearer' || !profile || !/^p7wi_[\x21-\x7e]+$/.test(instanceToken)) return undefined
    const normalized = new URL(origin).origin
    if (normalized !== origin || (expectedOrigin && normalized !== expectedOrigin)) return undefined
    const instanceId = record.instanceId === undefined ? undefined : text(record.instanceId)
    const generation = record.generation === undefined ? undefined : generationOf(record.generation)
    if ((record.instanceId !== undefined && !instanceId) || (record.generation !== undefined && generation === undefined)) return undefined
    return { origin, instanceToken, expiresAt, tokenType: 'Bearer', profile,
      ...(instanceId === undefined ? {} : { instanceId }),
      ...(generation === undefined ? {} : { generation }),
    }
  } catch { return undefined }
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object'); return value as Record<string, unknown> }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function timestamp(value: unknown): number | undefined { const result = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(result) ? (result < 10_000_000_000 ? result * 1000 : result) : undefined }
function generationOf(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }
function profileOf(value: unknown): P7AccountProfile | undefined { try { const body = object(value); const keys = ['userId', 'organizationId', 'displayName', 'role', 'sessionId'] as const; if (!keys.every(key => text(body[key])) || !Array.isArray(body.scopes) || !body.scopes.every(scope => typeof scope === 'string')) return undefined; const deviceId = body.deviceId === null ? 'web-browser' : text(body.deviceId); if (!deviceId) return undefined; return { userId: body.userId as string, organizationId: body.organizationId as string, displayName: body.displayName as string, role: body.role as string, deviceId, sessionId: body.sessionId as string, scopes: [...body.scopes] as string[] } } catch { return undefined } }
