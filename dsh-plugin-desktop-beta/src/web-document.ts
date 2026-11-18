/** Local Web document and authenticated HTTP forwarding for the application window. */
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { OnBeforeSendHeadersListenerDetails, WebContents } from 'electron'
import { NATIVE_ACCESS_HEADER } from './desktop-contract.ts'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}
/**
 * Pre-Cordis globals injected into the application index.
 *
 * `__DSH_FILE_UPLOAD__` is the file-upload plugin's documented page-owned carrier. Without it the
 * plugin posts Blob and stream bodies from a blob-URL dedicated Worker, and Electron never shows
 * Worker requests on a custom protocol to `webRequest` (verified on Electron 44.0.0): they cannot
 * carry the native renderer marker, and the protocol handler cannot tell an owned Worker from one
 * started by another window or a foreign frame. Every non-image attachment therefore received the
 * gate's 403. The page's own `fetch` runs in the owned main frame, which the gate already marks.
 * The carrier reports no byte progress; uploads go to the loopback Host, so the card only skips
 * its intermediate progress.
 */
const ZXRC_EMBLEM_B64 = 'iVBORw0KGgoAAAANSUhEUgAAACwAAAApCAYAAABOScuyAAADMUlEQVR4nOWZS4gcVRSGvzNGM6hRg6Lia0B8gEZR8RHUjdEEFQQFV0KQPBBRQZSgGAUXoigiaDaudCTZhKwCgu/Hwlc2cRHD6EKNoIgQnIjE+Iyf3Jnqoex0V9/bVjIt+aC7quuee87PrVu3zj0NLaC+r/7c8LmXlljQkp8JYFFD+8ktxWGsJT97BrT/MmqCDxkLSozV04DLqlv8RkR8XxpQXQ6cAXwOfBoRf7QqWD0OuAu4GbgWOLJq+gy4uFDsNcBbtUs/qO8BmyPi1RJf/QKsV3fbm59qdttt5qHKbk2DzYfqDUPNYfVs9RPgSeCkPn3nBBewt6Etjf7b6nNFgtUrgR3AUuaHB9XXsgSrFwAfA8cwv9ykvtkoWE0PYHoAjmA0WKE+2zTCLwOnMFqsU5ceIFi9BFjJaLKp1wg/M4SjhYeozznqis6PMfXUNF/+Y/BjB9guqo7TDMfD9RG+ZUgn6zPX18S3M9/wTtebLpdl6uKZM3WLZXxdvWLnUCfUD/rYP9IdXX3McmZngTpV0GmT2nceqhtqtnuqRKef7dXqlwWx13U6TmcYp3xidc69U+9Ji36V2TWS1n51Ut2foWFDp9O+DOM7OIio2zI0vNR56P7K8Hmfeu5BEnsncH6G6WzerO4yjz/VtRkCnlB3qFcMsBtXN5rP452Oab6VkFaV43sICHVzl+3dfcQuV78pjHt7p/OjlpN2CstqAi5Ud/axnVTndtQpoXE4JjoOlgzp4LuaiKmcJUm9bshYaf83w1hE7AS+oJyjCmyPro6zo1TO893Jz+yELmNf7fzXAba/Zdr14ndg8l+CI2ILkEZ6FHmgXgqoJ/C3Mnp8FBEv1i/MCY6Ir4C0iI8Ku4EbGzehEbERuJ/550fgqojYO3CbHxEpyVgF/M38sB24NCJ2ZRdSIuIV4KJU2GhwPD6EmPGGNoGnI+LyiOgk/PnVy4iYioiUNN8GpLrX/hYET/e4ll5ALwDnRcQByX5xMTAitgJb1TOB69PtAk5MBbwhBL8OPAWcBaSHfFvaNkVETsbYHrnFwMOyoD3GYSr49AHtJ4zav0jvAkuqpambAKZaivP/4x9fOQ6cN0eN7gAAAABJRU5ErkJggg=='

export const APP_BOOT_SCRIPT = '<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers();'
  + 'globalThis.__DSH_FILE_UPLOAD__ = { fetch: (input, init) => fetch(input, init) };'
  + '(function(){'
  + 'if(typeof document==="undefined")return;'
  + 'function initSplash(){'
  + 'if(document.getElementById("dhti-splash"))return;'
  + 'var s=document.createElement("div");s.id="dhti-splash";'
  + 's.innerHTML=\'<div style="height:24px"></div>\'+'
  + '\'<div style="display:flex;flex-direction:column;align-items:center;text-align:center;max-width:540px;width:100%">\'+'
  + '\'<div class="dhti-logo-box"><div class="dhti-logo-inner"><img class="dhti-logo-img" src="data:image/png;base64,' + ZXRC_EMBLEM_B64 + '" alt="中新融创"></div></div>\'+'
  + '\'<h1 class="dhti-slogan">洞察机会 · 明智投资</h1>\'+'
  + '\'<p class="dhti-subtitle">INSIGHT INTO OPPORTUNITIES · PRUDENT INVESTMENT</p>\'+'
  + '\'<div class="dhti-progress-box">\'+'
  + '\'<div class="dhti-track"><div class="dhti-indicator"></div></div>\'+'
  + '\'<p id="dhti-status-msg" class="dhti-status-txt">正在分配系统资源…</p>\'+'
  + '\'</div></div>\'+'
  + '\'<div class="dhti-footer-brand"><span class="dhti-brand-en">CHINA INNOVATIVE CAPITAL</span><span class="dhti-brand-cn">中新融创资本管理有限公司</span></div>\';'
  + 'if(document.body)document.body.prepend(s);else document.documentElement.appendChild(s);'
  + 'var msgs=["正在分配系统资源…","正在构建专属安全沙箱…","正在同步智能投研模型…","资源分配就绪，正在进入系统…"];'
  + 'var idx=0;var msgEl=document.getElementById("dhti-status-msg");'
  + 'var timer=setInterval(function(){if(idx<msgs.length-1){idx++;if(msgEl){msgEl.style.opacity="0";setTimeout(function(){msgEl.innerText=msgs[idx];msgEl.style.opacity="1";},220);}}},3500);'
  + 'var root=document.getElementById("root");'
  + 'if(root){'
  + 'var dismissed=false;'
  + 'function dismiss(){if(dismissed)return;dismissed=true;clearInterval(timer);if(msgEl){msgEl.innerText="资源就绪，正在进入工作台…";msgEl.style.color="#34d399";}'
  + 'setTimeout(function(){s.classList.add("dhti-fade-out");setTimeout(function(){s.remove();},900);},300);}'
  + 'var obs=new MutationObserver(function(){if(root.children.length>0&&!root.querySelector("[data-dsh-boot]")){obs.disconnect();dismiss();}});'
  + 'obs.observe(root,{childList:true,subtree:true});'
  + '}'
  + '}'
  + 'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",initSplash,{once:true});else initSplash();'
  + '})();</script>'

// Cover both the empty document and the official boot page; normal UI keeps its own palette.
const LOADING_STYLE = `<style id="dsh-next-loading-style">
html:has(#root:empty), html:has([data-dsh-boot]) { color-scheme: dark; background: #050608 !important; }
body:has(#root:empty), body:has([data-dsh-boot]) { background: #050608 !important; }
[data-dsh-boot] { display: none !important; }
#dhti-splash {
  position: fixed; inset: 0; width: 100%; height: 100%; background: #050608; z-index: 999999;
  display: flex; flex-direction: column; align-items: center; justify-content: space-between;
  padding: 48px 24px; box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  user-select: none; -webkit-user-select: none; color: #fff;
  transition: all 0.85s cubic-bezier(0.16, 1, 0.3, 1);
}
#dhti-splash.dhti-fade-out {
  opacity: 0 !important; transform: scale(1.04) !important; filter: blur(10px) !important; pointer-events: none !important;
}
@keyframes dhtiLogoAwaken {
  0% { opacity: 0; filter: blur(12px) brightness(0.15) drop-shadow(0 0 0px rgba(255,255,255,0)); transform: scale(0.90); }
  55% { opacity: 0.7; filter: blur(3px) brightness(0.85) drop-shadow(0 0 14px rgba(255,255,255,0.25)); transform: scale(0.98); }
  100% { opacity: 1; filter: blur(0px) brightness(1.1) drop-shadow(0 0 24px rgba(255,255,255,0.45)); transform: scale(1); }
}
@keyframes dhtiSubtlePulse {
  0%, 100% { opacity: 0.9; transform: scale(1); filter: drop-shadow(0 0 16px rgba(255,255,255,0.25)); }
  50% { opacity: 1; transform: scale(1.02); filter: drop-shadow(0 0 32px rgba(255,255,255,0.55)); }
}
@keyframes dhtiHairlineShimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}
@keyframes dhtiTextGleam {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.dhti-logo-box { margin-bottom: 32px; animation: dhtiLogoAwaken 2.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.dhti-logo-inner { display: flex; align-items: center; justify-content: center; min-height: 48px; animation: dhtiSubtlePulse 4.2s ease-in-out infinite; }
.dhti-logo-img { width: 48px; height: 44px; object-fit: contain; filter: drop-shadow(0 0 20px rgba(255,255,255,0.45)); }
.dhti-slogan {
  font-size: 28px; font-weight: 300; letter-spacing: 0.25em; padding-left: 0.25em; margin: 0 0 8px 0;
  background: linear-gradient(90deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,1) 50%, rgba(255,255,255,0.7) 100%);
  background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  animation: dhtiTextGleam 6s ease-in-out infinite;
}
.dhti-subtitle {
  font-size: 10px; letter-spacing: 0.35em; color: #737373; text-transform: uppercase; margin: 0 0 40px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.dhti-progress-box { width: 210px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.dhti-track { width: 100%; height: 2px; background: rgba(255,255,255,0.08); border-radius: 9999px; overflow: hidden; position: relative; }
.dhti-indicator { position: absolute; inset: 0; width: 35%; background: linear-gradient(90deg, transparent, #fff, transparent); animation: dhtiHairlineShimmer 2s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
.dhti-status-txt { font-size: 11px; color: #a3a3a3; letter-spacing: 0.05em; margin: 0; transition: opacity 0.3s; }
.dhti-footer-brand { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.dhti-brand-en { font-size: 11px; font-weight: 500; letter-spacing: 0.28em; color: #a3a3a3; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.dhti-brand-cn { font-size: 9px; letter-spacing: 0.2em; color: #525252; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
</style>`

/** Mark live same-origin frames in the owned window; strip the marker from other targets and redirects. */
export function appRequestHeaders(
  request: Pick<OnBeforeSendHeadersListenerDetails, 'url' | 'webContentsId' | 'webContents' | 'frame' | 'resourceType' | 'requestHeaders'>,
  owner: Pick<WebContents, 'id' | 'mainFrame'> | undefined,
  nativeToken: string | undefined,
): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(request.requestHeaders)
    .filter(([name]) => name.toLowerCase() !== NATIVE_ACCESS_HEADER))
  const target = new URL(request.url)
  if (target.protocol === 'dsh-app:' && target.host === 'app' && !target.username && !target.password && owner && nativeToken
    && request.webContentsId === owner.id && (!request.webContents || request.webContents.id === owner.id)
    && request.resourceType !== 'mainFrame' && request.frame
    && !request.frame.detached && request.frame.origin === 'dsh-app://app') headers[NATIVE_ACCESS_HEADER] = nativeToken
  return headers
}

/**
 * Read an application-owned static asset; the index waits for asynchronous Host injections.
 * @param request - Local application request.
 * @param root - Packaged Web dist directory.
 * @returns Static response, or a missing/invalid path response.
 */
export async function serveWebDocument(request: Request, root: string, waitForHost = true): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const url = new URL(request.url)
  let pathname: string
  try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
  const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const directory = resolve(root)
  if (!target.startsWith(directory + sep)) return new Response(null, { status: 403 })
  let body: Buffer
  try { body = await readFile(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
    throw error
  }
  const content = waitForHost && (pathname === '/' || pathname === '/index.html')
    ? body.toString().replace('<head>', '<head>' + LOADING_STYLE + APP_BOOT_SCRIPT) : new Uint8Array(body)
  return new Response(request.method === 'HEAD' ? null : content, {
    headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' },
  })
}

/**
 * Exchange the Host launch URL for an authority-bound browser cookie.
 * @param url - Authenticated URL reported by the owned Host process.
 * @returns Cookie header for requests forwarded to that Host.
 */
export async function authenticateWebHost(url: string, nativeToken?: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual', ...(nativeToken ? { headers: { [NATIVE_ACCESS_HEADER]: nativeToken } } : {}) })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Desktop Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * Response headers not relayed to the renderer. `set-cookie` would hand the
 * Host's authentication cookie to the page's cookie jar, which the shell owns
 * instead; the rest describe the Node `fetch` connection (its encoding, length,
 * and hop-by-hop transport), which Chromium never sees.
 */
const WITHHELD_RESPONSE_HEADERS = [
  'set-cookie',
  'content-encoding', 'content-length',
  'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/** Host routes whose responses carry immutable cache headers keyed by a per-process revision. */
const PLUGIN_BUNDLE_PATH = /^\/plugins\//u

/**
 * Forward local application requests to its authenticated Host, preserving streaming and cancellation.
 * Plugin bundle responses lose their `cache-control` for `no-store`: the Host marks them immutable
 * under a revision that changes every launch, so Chromium's disk cache would only accumulate bundles
 * no later launch can reuse.
 * @param request - Request from the application origin.
 * @param host - Owned Host URL.
 * @param cookie - Host-issued authentication cookie.
 * @returns Host response without connection-level headers.
 */
export async function forwardWebRequest(request: Request, host: string, cookie: string, nativeToken: string): Promise<Response> {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  // Custom-protocol fetches can omit Origin. The native session marks only
  // requests from live same-origin frames in our owned window; an HTTP header or referrer alone is
  // insufficient. Keep this compatible with the upstream's Electron 44.0 ABI.
  if (source.protocol !== 'dsh-app:' || source.host !== 'app' || source.username || source.password
    || !nativeToken || request.headers.get(NATIVE_ACCESS_HEADER) !== nativeToken) return new Response(null, { status: 403 })
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  // The official connect.js accepts an explicit ws query. Its same-origin
  // fallback would otherwise derive ws://app from this custom-protocol iframe.
  // Keep the frontend local, and use the authenticated Host's public CDP proxy
  // (not the Inspector Worker's private port). Its CSP already permits loopback.
  if (source.pathname === '/inspector/devtools/devtools_app.html' && ['GET', 'HEAD'].includes(request.method)) {
    const endpoint = new URL(host)
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
      return new Response(null, { status: 503 })
    }
    endpoint.pathname = '/inspector/devtools/cdp'
    endpoint.search = ''
    endpoint.hash = ''
    for (const id of source.searchParams.getAll('clientSourceId')) endpoint.searchParams.append('clientSourceId', id)
    const connection = endpoint.host + endpoint.pathname + endpoint.search
    if (source.searchParams.getAll('ws').length !== 1 || source.searchParams.get('ws') !== connection || source.searchParams.has('wss')) {
      source.searchParams.delete('wss')
      source.searchParams.set('ws', connection)
      return new Response(null, { status: 302, headers: { location: source.href, 'cache-control': 'no-store' } })
    }
  }
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site', NATIVE_ACCESS_HEADER]) headers.delete(name)
  headers.set('cookie', cookie)
  headers.set(NATIVE_ACCESS_HEADER, nativeToken)
  // Preserve same-origin semantics for every owned plugin route, including
  // /dsh-market/*. Translate only after validating the native frame marker and
  // source origin; the HTTP client supplies Host from this owned target URL.
  headers.set('origin', target.origin)
  headers.set('sec-fetch-site', 'same-origin')
  const init = { method: request.method, headers, body: request.body, signal: request.signal, duplex: 'half', redirect: 'manual' as const }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name)
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: outgoing })
}
