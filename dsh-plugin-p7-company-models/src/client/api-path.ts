const WORKSPACE_BASE = /^\/dsh\/instances\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/i

/** Keep client API calls below a mounted Web workspace, otherwise use Desktop root. */
export function resolveClientApiPath(path: string, baseURI = typeof document === 'undefined' ? undefined : document.baseURI): string {
  if (!path.startsWith('/')) throw new TypeError('client API path must be root-relative')
  if (!baseURI) return path
  try {
    const pathname = new URL(baseURI).pathname
    return WORKSPACE_BASE.test(pathname) ? `${pathname.slice(0, -1)}${path}` : path
  } catch {
    return path
  }
}
