import type { DesktopRuntime } from './runtime.ts'

/**
 * Desktop-owned system-browser bridge for P7 OAuth. Root composition passes
 * this function to the account broker; the broker itself has no Electron code.
 */
export function openP7AccountBrowser(runtime: Pick<DesktopRuntime, 'platformLogin'>, url: string): void {
  const target = new URL(url)
  if (target.username || target.password || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)))) throw new TypeError('Invalid P7 authorization URL.')
  runtime.platformLogin({ action: 'open', url: target.href, external: true })
}

export function p7AccountStore(runtime: DesktopRuntime): {
  readonly clientVersion: string
  load(origin: string): Promise<string | undefined>
  save(origin: string, refreshToken: string): Promise<void>
  clear(origin: string): Promise<void>
} | undefined {
  const vault = runtime.p7SessionVault?.bind(runtime)
  if (!vault) return undefined
  return {
    clientVersion: runtime.updates.currentVersion,
    load: async origin => (await vault({ action: 'load', origin })).refreshToken,
    save: async (origin, refreshToken) => { await vault({ action: 'save', origin, refreshToken }) },
    clear: async origin => { await vault({ action: 'clear', origin }) },
  }
}
