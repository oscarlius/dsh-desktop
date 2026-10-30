import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { validateP7Origin, type P7Fetch } from './p7-client.js'

export interface P7AccountProfile { userId: string; organizationId: string; displayName: string; role: string; deviceId: string; sessionId: string; scopes: string[] }
export interface P7AccountStatus { phase: 'signed-out' | 'pending' | 'signed-in' | 'approval-required' | 'upgrade-required' | 'expired' | 'error'; profile: P7AccountProfile | null; expiresAt: number | null; authorizationUrl: string | null; upgradeUrl: string | null; message: string | null }
export interface P7UsageTotals { requests: number; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; searchCalls: number; mcpCalls: number; costMicrounits: number | null; currency: string | null }
export interface P7Usage { from: string; to: string; timeZone: string; totals: P7UsageTotals; unknownRequestCount: number; partialRequestCount: number; unattributedLegacyRequestCount: number; items: Array<Record<string, unknown>> }
type Session = { origin: string; accessToken: string; refreshToken: string; expiresAt: number; profile: P7AccountProfile }
type Pending = { state: string; verifier: string; transactionId: string; pollToken: string; server: Server; redirectUri: string; authorizationUrl: string; expiresAt: number; generation: number; origin: string }
const REGISTRY = Symbol.for('dsh.p7.account-broker.registry')
type BrokerRegistry = Map<string, AccountBroker>
function registry(): BrokerRegistry { const host = globalThis as typeof globalThis & { [REGISTRY]?: BrokerRegistry }; return host[REGISTRY] ??= new Map() }
/** Resolve the Host broker for one Profile across independently bundled plugins. */
export function getAccountBroker(profileId: string): AccountBroker | undefined { return registry().get(profileId) }
export interface P7AccountStore { readonly clientVersion?: string; load(origin: string): Promise<string | undefined>; save(origin: string, refreshToken: string): Promise<void>; clear(origin: string): Promise<void> }
class AccountHttpError extends Error { constructor(readonly status: number, readonly detail?: string, readonly minimumVersion?: string, readonly upgradeUrl?: string) { super(detail ?? `P7 identity request failed (${String(status)})`) } }

/** Host-only P7 identity session. Tokens deliberately remain in process memory. */
export class AccountBroker {
  private session: Session | undefined
  private pending: Pending | undefined
  private refreshFlight: Promise<string> | undefined
  private restoreFlight: Promise<void> | undefined
  private phase: P7AccountStatus['phase'] = 'signed-out'
  private message: string | null = null
  private personalMode = false
  private readonly listeners = new Set<(status: P7AccountStatus) => void>()
  private browserLauncher: ((url: string) => Promise<void> | void) | undefined
  private authGeneration = 0
  private upgradeUrl: string | null = null
  private storeQueue: Promise<void> = Promise.resolve()
  constructor(private readonly options: { origin(): string | null; profileId: string; requirePersonalLogin?: boolean; deviceFingerprint?(): string; clientVersion?: string; store?: P7AccountStore; fetch?: P7Fetch; openBrowser?(url: string): Promise<void> | void; now?(): number }) { this.personalMode = options.requirePersonalLogin === true; this.browserLauncher = options.openBrowser; registry().set(options.profileId, this) }
  status(): P7AccountStatus { return { phase: this.phase, profile: this.session?.profile ?? null, expiresAt: this.session?.expiresAt ?? null, authorizationUrl: this.pending?.authorizationUrl ?? null, upgradeUrl: this.upgradeUrl, message: this.message } }
  /** Gateway origin and a per-operation token getter for MCP/runtime consumers. */
  connection(): { origin: string | null; getValidAccessToken: () => Promise<string>; usesPersonalToken: () => boolean } { return { origin: this.options.origin(), getValidAccessToken: () => this.getValidAccessToken(), usesPersonalToken: () => this.usesPersonalToken() } }
  /** Once a personal sign-in starts, downstream calls must never fall back to a legacy shared key. */
  usesPersonalToken(): boolean { return this.options.requirePersonalLogin === true || this.personalMode }
  setPersonalMode(value: boolean): void { this.personalMode = this.options.requirePersonalLogin === true || value }
  subscribe(listener: (status: P7AccountStatus) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  setBrowserLauncher(launcher: ((url: string) => Promise<void> | void) | undefined): void { this.browserLauncher = launcher }
  /** Restore only through the OS-backed refresh store; no token is read from profile files. */
  async restore(): Promise<void> {
    if (this.restoreFlight) return await this.restoreFlight
    this.restoreFlight = this.restoreCurrent().finally(() => { this.restoreFlight = undefined })
    return await this.restoreFlight
  }
  async login(): Promise<P7AccountStatus> {
    const generation = ++this.authGeneration
    this.personalMode = true; this.publish()
    await this.cancelPending()
    if (generation !== this.authGeneration) throw new Error('P7 personal session changed.')
    const origin = this.requireOrigin()
    if (!await this.checkPolicy(origin, generation)) return this.status()
    if (!this.isCurrent(origin, generation)) throw new Error('P7 personal session changed.')
    const state = random(32); const verifier = random(48); const challenge = createHash('sha256').update(verifier).digest('base64url')
    const server = createServer((req, res) => { void this.callback(req.url ?? '', res) })
    const port = await new Promise<number>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve((server.address() as import('node:net').AddressInfo).port)) })
    const redirectUri = `http://127.0.0.1:${String(port)}/p7-desktop-auth/callback`
    try {
      const response = await this.request(origin, '/api/v1/desktop-auth/login-transactions', { deviceFingerprint: this.options.deviceFingerprint?.() ?? createHash('sha256').update(this.options.profileId).digest('hex'), platform: process.platform, clientVersion: this.options.clientVersion ?? '2.0.18-beta.15', redirectUri, state, codeChallenge: challenge, codeChallengeMethod: 'S256' })
      if (!this.isCurrent(origin, generation)) throw new Error('P7 personal session changed.')
      const value = object(response); const transactionId = text(value.transactionId); const pollToken = text(value.pollToken); const authorizationUrl = text(value.authorizationUrl); const expiresAt = timestamp(value.expiresAt)
      if (!transactionId || !pollToken || !authorizationUrl || expiresAt === undefined) throw new Error('invalid login transaction')
      this.pending = { state, verifier, transactionId, pollToken, server, redirectUri, authorizationUrl, expiresAt, generation, origin }
      this.phase = 'pending'; this.message = null; this.publish()
      await (this.browserLauncher ?? openSystemBrowser)(authorizationUrl)
      return this.status()
    } catch (error) { await close(server); if (generation === this.authGeneration) this.fail(error, 'Company sign-in could not be started.'); throw error }
  }
  async getValidAccessToken(): Promise<string> {
    if (!this.session || this.session.origin !== this.requireOrigin()) throw new Error('P7 personal sign-in is required.')
    if (this.session.expiresAt > this.now() + 60_000) return this.session.accessToken
    this.refreshFlight ??= this.refresh().finally(() => { this.refreshFlight = undefined })
    return await this.refreshFlight
  }
  async usage(from: string, to: string, groupBy: 'day' | 'model' | 'service' = 'day'): Promise<P7Usage> {
    const origin = this.requireOrigin(); const token = await this.getValidAccessToken()
    const response = await this.fetch(`${origin}/api/v1/me/usage?${new URLSearchParams({ from, to, groupBy })}`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, redirect: 'error' })
    if (!response.ok) { await this.handleUnauthorized(response.status); throw new Error('P7 usage is unavailable.') }
    return await response.json() as P7Usage
  }
  async logout(): Promise<void> {
    const current = this.session
    const origin = current?.origin ?? this.options.origin()
    const generation = ++this.authGeneration
    await this.cancelPending()
    this.session = undefined; this.phase = 'signed-out'; this.message = null; this.upgradeUrl = null; this.publish()
    // Restore may have loaded a token without having accepted a session yet.
    // Clear the origin in that case too, otherwise a logout before completion
    // would silently sign the user back in after restart.
    if (origin) await this.queueStore(generation, () => this.options.store?.clear(validateP7Origin(origin)))
    if (current) try { await this.fetch(`${current.origin}/api/v1/desktop-auth/session/revoke`, { method: 'POST', headers: { authorization: `Bearer ${current.accessToken}` }, redirect: 'error' }) } catch {}
  }
  async dispose(): Promise<void> { this.authGeneration++; await this.cancelPending(); this.session = undefined; if (registry().get(this.options.profileId) === this) registry().delete(this.options.profileId) }
  private async callback(raw: string, res: import('node:http').ServerResponse): Promise<void> {
    const pending = this.pending; const url = new URL(raw, 'http://127.0.0.1')
    if (!pending || url.pathname !== '/p7-desktop-auth/callback' || url.searchParams.get('state') !== pending.state || url.searchParams.get('transactionId') !== pending.transactionId || pending.expiresAt <= this.now()) { res.statusCode = 400; res.end('Sign-in could not be verified.'); return }
    res.statusCode = 200; res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('Completing sign-in verification. You can return to DSH.')
    // Do not await close here: the browser callback itself may hold the last
    // keep-alive socket, and waiting for it would deadlock token exchange.
    pending.server.close(); this.pending = undefined
    try { const token = await this.request(pending.origin, '/api/v1/desktop-auth/token', { transactionId: pending.transactionId, pollToken: pending.pollToken, codeVerifier: pending.verifier }); if (!this.isCurrent(pending.origin, pending.generation)) return; await this.accept(token, pending.origin, pending.generation) } catch (error) { if (this.isCurrent(pending.origin, pending.generation)) this.fail(error, 'Company sign-in could not be completed.') }
  }
  private async refresh(): Promise<string> { const session = this.session; const generation = this.authGeneration; if (!session) throw new Error('P7 personal sign-in is required.'); try { const token = await this.request(session.origin, '/api/v1/desktop-auth/token/refresh', { refreshToken: session.refreshToken }); if (!this.isCurrent(session.origin, generation) || this.session !== session) throw new Error('P7 personal session changed.'); await this.accept(token, session.origin, generation); return this.session!.accessToken } catch (error) { if (this.isCurrent(session.origin, generation) && this.session === session) await this.handleRefreshFailure(session.origin, error); throw error } }
  private async accept(value: unknown, origin: string, generation: number): Promise<void> {
    const body = object(value), accessToken = text(body.accessToken), refreshToken = text(body.refreshToken)
    const expiresAt = timestamp(body.expiresAt), profile = profileOf(body.profile)
    if (!accessToken || !refreshToken || expiresAt === undefined || !profile) throw new Error('invalid token response')
    if (!this.isCurrent(origin, generation)) return
    // Tokens are resolved per operation. Renewing this same identity must not
    // tell consumers to tear down the company's model and tool catalogs.
    const changed = this.phase !== 'signed-in' || this.session?.origin !== origin
      || JSON.stringify(this.session?.profile) !== JSON.stringify(profile)
    // A failed durable save must not expose an authenticated session while the
    // UI reports failure. Rotation already invalidated the previous credential.
    try { await this.queueStore(generation, () => this.options.store?.save(origin, refreshToken)) }
    catch (error) { if (this.isCurrent(origin, generation)) this.session = undefined; throw error }
    if (!this.isCurrent(origin, generation)) return
    this.session = { origin, accessToken, refreshToken, expiresAt, profile }
    this.phase = 'signed-in'; this.message = null; this.upgradeUrl = null
    if (changed) this.publish()
  }
  private async request(origin: string, path: string, body: object): Promise<unknown> { const response = await this.fetch(`${origin}${path}`, { method: 'POST', redirect: 'error', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw await this.httpError(response); return await response.json() }
  private async checkPolicy(origin: string, generation: number): Promise<boolean> {
    const response = await this.fetch(`${origin}/api/v1/desktop-auth/policy?${new URLSearchParams({ clientVersion: this.options.clientVersion ?? '2.0.18-beta.15' })}`, { headers: { accept: 'application/json' }, redirect: 'error' })
    if (!response.ok) {
      const error = await this.httpError(response)
      if (generation === this.authGeneration && this.personalMode) this.fail(error, 'Company sign-in could not be started.')
      throw error
    }
    const policy = object(await response.json())
    if (generation !== this.authGeneration || !this.personalMode) return false
    if (policy.upgradeRequired !== true) return true
    this.phase = 'upgrade-required'
    this.message = text(policy.message) ?? `Update DSH Desktop to ${text(policy.minimumVersion) ?? 'the required version'} before signing in.`
    this.upgradeUrl = safeUpgradeUrl(text(policy.upgradeUrl))
    this.publish()
    return false
  }
  private async handleUnauthorized(status: number): Promise<void> { if (status === 401 || status === 403) { const session = this.session; this.session = undefined; if (session) await this.expire(session.origin, new Error('unauthorized')) } }
  private requireOrigin(): string { const origin = this.options.origin(); if (!origin) throw new Error('Connect the P7 company service before signing in.'); return validateP7Origin(origin) }
  private fetch(input: RequestInfo | URL, init: RequestInit): Promise<Response> { return (this.options.fetch ?? globalThis.fetch)(input, init) }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private async cancelPending(): Promise<void> { if (this.pending) { const server = this.pending.server; this.pending = undefined; await close(server) } }
  private async restoreCurrent(): Promise<void> {
    const origin = this.options.origin(); if (!origin || !this.personalMode || !this.options.store) return
    const generation = this.authGeneration; const normalized = validateP7Origin(origin)
    try {
      if (!await this.checkPolicy(normalized, generation) || generation !== this.authGeneration || !this.personalMode) return
    } catch (error) {
      if (generation === this.authGeneration && this.personalMode) await this.handleRestoreFailure(normalized, error)
      return
    }
    let refreshToken: string | undefined
    try { refreshToken = await this.options.store.load(normalized) }
    catch (error) {
      if (this.isCurrent(normalized, generation)) await this.handleRestoreFailure(normalized, error)
      return
    }
    if (!refreshToken || generation !== this.authGeneration || !this.personalMode || this.options.origin() !== origin) return
    try { const token = await this.request(normalized, '/api/v1/desktop-auth/token/refresh', { refreshToken }); if (generation !== this.authGeneration || !this.personalMode || this.options.origin() !== origin) return; await this.accept(token, normalized, generation) }
    catch (error) { if (generation === this.authGeneration && this.personalMode) await this.handleRestoreFailure(normalized, error) }
  }
  private async httpError(response: Response): Promise<AccountHttpError> {
    let detail: string | undefined; let upgradeUrl: string | undefined
    try { const value = object(await response.json()); detail = text(value.detail) ?? text(value.message); upgradeUrl = text(value.upgradeUrl) ?? text(value.downloadUrl) } catch {}
    return new AccountHttpError(response.status, detail, response.headers.get('x-p7-minimum-desktop-version') ?? undefined, response.headers.get('x-p7-upgrade-url') ?? upgradeUrl)
  }
  private async handleRestoreFailure(origin: string, error: unknown): Promise<void> {
    if (clearsRefresh(error)) await this.expire(origin, error)
    else this.fail(error, 'Company sign-in could not be restored. It will be retried when P7 is available.')
  }
  private async handleRefreshFailure(origin: string, error: unknown): Promise<void> {
    if (clearsRefresh(error)) await this.expire(origin, error)
    else {
      // A timeout/5xx is not a sign-out. Preserve the identity and catalogs;
      // this operation still fails, and the next request retries renewal.
      this.message = 'Company sign-in could not be refreshed. It will be retried when P7 is available.'
      if (!this.session || error instanceof AccountHttpError && error.status === 426) this.fail(error, this.message)
    }
  }
  private async expire(origin: string, error: unknown): Promise<void> { this.session = undefined; await this.queueStore(this.authGeneration, () => this.options.store?.clear(origin)); this.fail(error, 'Your company sign-in expired. Sign in again.', 'expired') }
  private fail(error: unknown, fallback: string, phase: P7AccountStatus['phase'] = 'error'): void { const upgrade = error instanceof AccountHttpError && error.status === 426; this.phase = upgrade ? 'upgrade-required' : phase; this.message = upgrade ? (error.detail ?? `Update DSH Desktop to ${error.minimumVersion ?? 'the required version'} before signing in.`) : fallback; this.upgradeUrl = upgrade && error instanceof AccountHttpError ? safeUpgradeUrl(error.upgradeUrl) : null; this.publish() }
  private async queueStore(generation: number, operation: () => Promise<void> | void): Promise<void> { const next = this.storeQueue.then(async () => { if (generation === this.authGeneration) await operation() }); this.storeQueue = next.catch(() => {}); await next }
  private isCurrent(origin: string, generation: number): boolean { return generation === this.authGeneration && this.personalMode && sameOrigin(this.options.origin(), origin) }
  private publish(): void { const status = this.status(); for (const listener of this.listeners) listener(status) }
}
function random(bytes: number): string { return randomBytes(bytes).toString('base64url') }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid response'); return value as Record<string, unknown> }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function timestamp(value: unknown): number | undefined {
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value < 10_000_000_000 ? value * 1000 : value
}
function profileOf(value: unknown): P7AccountProfile | undefined { try { const body = object(value); const keys = ['userId', 'organizationId', 'displayName', 'role', 'deviceId', 'sessionId'] as const; if (!keys.every(key => text(body[key]))) return undefined; if (!Array.isArray(body.scopes) || !body.scopes.every(scope => typeof scope === 'string')) return undefined; return { userId: body.userId as string, organizationId: body.organizationId as string, displayName: body.displayName as string, role: body.role as string, deviceId: body.deviceId as string, sessionId: body.sessionId as string, scopes: [...body.scopes] as string[] } } catch { return undefined } }
function close(server: Server): Promise<void> { return new Promise(resolve => server.close(() => resolve())) }
function openSystemBrowser(value: string): void {
  const url = new URL(value)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Invalid P7 authorization URL.')
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url.href] : [url.href]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }); child.unref()
}
function safeUpgradeUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}
function clearsRefresh(error: unknown): boolean {
  return error instanceof AccountHttpError && [400, 401, 403].includes(error.status)
}
function sameOrigin(current: string | null, expected: string): boolean {
  if (!current) return false
  try { return validateP7Origin(current) === expected } catch { return false }
}
