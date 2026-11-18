/** Keep upstream HTTP routing while requiring Host credentials for Market routes. */
import { hostLog, hostOperation } from './host/logging.ts'
import WebServer, { type WebResourceRoute, type WebRoute, type WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import { decideDesktopBrowserAccess, nextBrowserAccess } from './desktop-browser-access.ts'
import type { Duplex } from 'node:stream'
import { Service } from '@deepseek-ai/cordis'
import { createHostSelfAccess, hasHostSelfAccess, installHostSelfFetch, type HostSelfAccess } from './host-self-fetch.ts'
import { desktopBrowserUrlHasRendererMarkers } from './desktop-browser-access.ts'

export default class NextWebServer extends WebServer {
  static override Config = WebServer.Config
  private readonly browserSockets = new Set<Duplex>()
  private hostSelfAccess: HostSelfAccess | undefined

  /** Revoke existing browser streams as well as new requests; native streams stay alive. */
  setBrowserAccess(enabled: boolean): void {
    const access = nextBrowserAccess()
    if (!access) throw new Error('Native browser-access policy is unavailable')
    access.setOrdinaryBrowserEnabled(enabled)
    if (!enabled) {
      for (const socket of this.browserSockets) socket.destroy()
      this.browserSockets.clear()
    }
  }

  private permits(request: Parameters<WebRoute['handler']>[0]): boolean {
    if (hasHostSelfAccess(request.headers, this.hostSelfAccess) && !desktopBrowserUrlHasRendererMarkers(request.url)) return true
    const access = nextBrowserAccess()
    return !access || decideDesktopBrowserAccess(access, request) !== 'denied'
  }

  private permitsResource(request: Request): boolean {
    const url = new URL(request.url)
    return this.permits({ headers: Object.fromEntries(request.headers), url: `${url.pathname}${url.search}` } as Parameters<WebRoute['handler']>[0])
  }

  override async [Service.init](): Promise<void> {
    await super[Service.init]()
    this.hostSelfAccess = createHostSelfAccess()
    const uninstall = installHostSelfFetch(this.getOrigin(), this.hostSelfAccess)
    this.ctx.effect(() => uninstall, 'Desktop Host self-fetch capability')
  }

  override register(route: WebRoute): () => void {
    return super.register({ ...route, handler: this.observeHttp(route.path, async (request, response) => {
      if (!this.permits(request)) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end('Browser access is disabled'); return }
      if (route.path !== '/api/community-market' && !route.path.startsWith('/api/community-market/') && route.path !== '/api/desktop-skills') {
        await route.handler(request, response); return
      }
      const connection = this.ctx.get('connection')
      const rejection = connection === undefined ? 503 : connection.requestRejection(request)
      if (rejection !== undefined) {
        response.writeHead(rejection, { 'cache-control': 'no-store' })
        response.end(route.path === '/api/desktop-skills' ? 'Skill management authentication required' : 'Market request authentication required')
        return
      }
      await route.handler(request, response)
    }) })
  }

  private observeHttp(route: string, handler: WebRoute['handler']): WebRoute['handler'] {
    return async (request, response) => {
      const end = hostOperation('host.http', 'request', { route, method: request.method ?? '' }, true)
      const finish = () => { end(undefined, { status: response.statusCode, aborted: !response.writableFinished }); response.off('finish', finish); response.off('close', finish) }
      response.once('finish', finish); response.once('close', finish)
      try { await handler(request, response) } catch (error) { response.off('finish', finish); response.off('close', finish); end(error); throw error }
    }
  }

  override registerFallback(fallback: WebRoute['handler'] | Pick<WebResourceRoute, 'resource'>): () => void {
    if (typeof fallback !== 'function') return super.registerFallback({ resource: async (request, peer) => {
      if (!this.permitsResource(request)) return new Response('Browser access is disabled', { status: 403, headers: { 'cache-control': 'no-store' } })
      return fallback.resource(request, peer)
    } })
    return super.registerFallback(this.observeHttp('fallback', async (request, response) => {
      if (!this.permits(request)) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end('Browser access is disabled'); return }
      await fallback(request, response)
    }))
  }

  override registerUpgrade(route: WebUpgradeRoute): () => void {
    return super.registerUpgrade({ ...route, handler: (request, socket, head) => {
      hostLog({ source: 'host.http', event: 'upgrade', fields: { route: route.path }, developer: true })
      if (!this.permits(request)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
      const access = nextBrowserAccess()
      if (access && decideDesktopBrowserAccess(access, request) === 'browser') {
        this.browserSockets.add(socket)
        socket.once('close', () => this.browserSockets.delete(socket))
      }
      return route.handler(request, socket, head)
    } })
  }
}
