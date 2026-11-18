import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { exchangeLaunchToken, writeStoredCoreCookie } from './core-cookie.js'

export interface OfficialWebLaunch { command: string; args: readonly string[]; upstreamOrigin: string; publicAuthority: string }
const STATE_DIR = '/run/p7-web-state'

/**
 * Resolves the writable home directory for the web session and its child.
 * Workspace containers run with a read-only root filesystem and Docker injects
 * the passwd home (/home/dsh) as HOME, so an inherited HOME cannot be trusted
 * to be writable; the session home lives under DSH_HOME instead. An explicit
 * DSH_WEB_HOME always wins and the directory is created on boot.
 */
export function ensureWritableHome(dshHome: string): string {
  const home = process.env.DSH_WEB_HOME ?? join(dshHome, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  return home
}

/** Starts the official CLI without leaking its one-time URL to inherited stdout. */
export async function launchOfficialWeb(input: OfficialWebLaunch, stateDir = STATE_DIR): Promise<ChildProcess> {
  const child = spawn(input.command, [...input.args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  // stderr carries no startup URL, so forward it to the container log and keep
  // a bounded tail for startup failures. stdout stays capture-only: it holds
  // the one-time token URL and must never reach the logs.
  let stderrTail = ''
  child.stderr?.on('data', chunk => {
    stderrTail = (stderrTail + String(chunk)).slice(-16_384)
    process.stderr.write(chunk)
  })
  const url = await new Promise<string>((resolve, reject) => {
    let text = ''; let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true; clearTimeout(timeout)
      if (!child.killed) child.kill()
      const tail = stderrTail.trim()
      reject(tail ? new Error(`${error.message}\n--- official web stderr (last 16 KiB) ---\n${tail}`) : error)
    }
    const timeout = setTimeout(() => fail(new Error('official web startup URL unavailable')), 30_000)
    child.once('error', error => fail(error))
    child.once('exit', code => fail(new Error(`official web exited before startup URL (${code ?? 'signal'})`)))
    child.stdout?.on('data', chunk => {
      if (settled) return
      text = (text + String(chunk)).slice(-65_536)
      const match = /dsh web:\s+(https?:\/\/\S+\?token=[^\s]+)/.exec(text)
      if (!match || settled) return
      settled = true; clearTimeout(timeout); resolve(match[1]!)
    })
  })
  const token = new URL(url).searchParams.get('token'); if (!token) throw new Error('official web startup URL lacked a token')
  const upstream = new URL('/', input.upstreamOrigin)
  const cookie = await exchangeLaunchToken(upstream, input.publicAuthority, token)
  await writeStoredCoreCookie(cookie, join(stateDir, 'core-cookie.json'))
  return child
}
