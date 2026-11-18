import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ensureWritableHome, launchOfficialWeb } from '../src/launcher.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function withHome(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env.HOME
  if (value === undefined) delete process.env.HOME
  else process.env.HOME = value
  try { await run() } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved }
}

it('exchanges the startup token through the private listener with the public authority', async () => {
  const expiry = 'Wed, 01 Jan 2048 00:00:00 GMT'
  let host = ''
  const server = createServer((request, response) => {
    host = String(request.headers.host)
    expect(request.url).toBe('/?token=synthetic-token')
    response.writeHead(303, { 'set-cookie': `dsh=synthetic-cookie; Expires=${expiry}; HttpOnly`, location: '/' }).end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-launcher-')); roots.push(root)
  const script = join(root, 'official-web.mjs')
  await writeFile(script, "console.log('dsh web: http://127.0.0.1/?token=synthetic-token'); setInterval(() => {}, 1_000)\n")
  let child: Awaited<ReturnType<typeof launchOfficialWeb>> | undefined
  try {
    child = await launchOfficialWeb({ command: process.execPath, args: [script], upstreamOrigin: `http://127.0.0.1:${port}`, publicAuthority: 'workspace.example:8092' }, root)
    expect(host).toBe('workspace.example:8092')
    expect(JSON.parse(await readFile(join(root, 'core-cookie.json'), 'utf8'))).toEqual({ cookie: 'dsh=synthetic-cookie', expiresAt: Date.parse(expiry) })
  } finally {
    child?.kill()
    server.close(); await once(server, 'close')
  }
})

it('surfaces the official web stderr tail when startup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-launcher-')); roots.push(root)
  const script = join(root, 'failing-web.mjs')
  await writeFile(script, "console.error('plugin dsh-web-host failed: managed package path is occupied'); process.exit(1)\n")
  await expect(launchOfficialWeb({ command: process.execPath, args: [script], upstreamOrigin: 'http://127.0.0.1:1', publicAuthority: 'workspace.example:8092' }, root))
    .rejects.toThrow('managed package path is occupied')
})

it('redirects an injected read-only container HOME under DSH_HOME and creates it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-home-')); roots.push(root)
  await withHome('/home/dsh', async () => {
    const resolved = ensureWritableHome(join(root, 'dsh'))
    expect(resolved).toBe(join(root, 'dsh', 'home'))
    expect(process.env.HOME).toBe(resolved)
    expect((await stat(resolved)).isDirectory()).toBe(true)
  })
})

it('honors an explicit DSH_WEB_HOME override and still ensures it exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-home-')); roots.push(root)
  const custom = join(root, 'custom-home')
  const saved = process.env.DSH_WEB_HOME
  process.env.DSH_WEB_HOME = custom
  try {
    await withHome('/home/dsh', async () => {
      expect(ensureWritableHome(join(root, 'dsh'))).toBe(custom)
      expect(process.env.HOME).toBe(custom)
      expect((await stat(custom)).isDirectory()).toBe(true)
    })
  } finally { if (saved === undefined) delete process.env.DSH_WEB_HOME; else process.env.DSH_WEB_HOME = saved }
})
