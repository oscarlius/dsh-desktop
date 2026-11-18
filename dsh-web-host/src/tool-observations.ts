import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import type {} from '@deepseek-ai/dsh-tools'
import { WebAccountBroker } from './web-account.js'

type Status = 'succeeded' | 'failed' | 'cancelled' | 'unknown'
type Outcome = { status: Status; code?: string; reason?: string }
type Observation = Outcome & { seq: number; turn: number; tool: string; target?: string }
type Entry = { session: string; event: Observation }
type Call = {
  seq: SessionEvent['seq']; tool: string; target?: string; shell?: Outcome
  ptc?: { root: string; parent: string }
}
type ActiveTurn = { turn: number; calls: Map<string, Call>; nested: Map<string, Call> }
type Account = Pick<WebAccountBroker, 'restore' | 'status' | 'getValidAccessToken'>

const MAX_BATCH = 20
const MAX_BACKLOG = 512
const MAX_OUTBOX_BYTES = 512 * 1024
const MAX_CALLS_PER_TURN = 256
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
const FILE_TOOLS = new Set(['read', 'read_file', 'read_image', 'write', 'write_file', 'edit', 'edit_file', 'mkdir', 'make_directory', 'create_directory'])
const IGNORE_TOOLS = new Set(['search_company_memory', 'search_personal_memory', 'run_code'])

const FAILURE_REASONS: Readonly<Record<string, string>> = {
  ABORTED: 'Tool call cancelled',
  ABORTED_BEFORE_DISPATCH: 'Tool call cancelled before dispatch',
  FS_ABORTED: 'Tool call cancelled',
  ENOENT: 'File not found',
  FS_NOT_FOUND: 'File or requested position was not found',
  EACCES: 'Permission denied',
  EPERM: 'Permission denied',
  FS_PERMISSION_DENIED: 'Permission denied',
  FS_SANDBOX_DENIED: 'Sandbox denied access',
  FS_NOT_DIRECTORY: 'Target is not a directory',
  FS_NOT_REGULAR_FILE: 'Target is not a regular file',
  FS_NOT_TEXT: 'Target is not a text file',
  FS_TOO_LARGE: 'File exceeds the tool limit',
  FS_IO_ERROR: 'Filesystem operation failed',
  FS_STALE_VERSION: 'File changed since it was observed',
  FS_NOT_OBSERVED: 'File must be read before editing',
  FS_AMBIGUOUS_EDIT: 'Edit matched more than one location',
  FS_EDIT_NOT_FOUND: 'Edit text was not found',
  UNKNOWN_TOOL: 'Tool is unavailable',
  TOOL_OUTPUT_INVALID: 'Tool returned an invalid result',
  TOOL_ARGS_INVALID: 'Tool arguments were invalid',
  TOOL_TIMEOUT: 'Tool execution timed out',
}
const CANCEL_CODES = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH', 'FS_ABORTED'])
const SAFE_REASONS = new Set([
  ...Object.values(FAILURE_REASONS), 'File not found', 'Requested file position was out of range',
  'Tool call failed', 'Sandbox denied the command', 'Command timed out', 'Command was stopped',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function safeTarget(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._ ()-]{0,159}$/u.test(value)
    && !/(?:p7wi_|p7at_|sk-[\w-]{8,}|\b[A-Fa-f0-9]{32,}\b|[A-Za-z0-9_-]{40,})/.test(value)
    && !/^(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(value)
}

function targetFor(tool: string, args: unknown): string | undefined {
  if (!FILE_TOOLS.has(tool)) return undefined
  if (typeof args === 'string') {
    if (args.length > 64 * 1024) return undefined
    try { args = JSON.parse(args) } catch { return undefined }
  }
  const fields = record(args)
  const path = fields?.file_path ?? fields?.path ?? fields?.filePath
  if (typeof path !== 'string' || path.length > 4096 || /[\x00-\x1f\x7f?#]/.test(path)) return undefined
  if (/^[\\/]{2}|^[a-z][a-z\d+.-]*:(?![\\/])|^[a-z][a-z\d+.-]+:/i.test(path)) return undefined
  const name = win32.basename(path)
  return safeTarget(name) ? name : undefined
}

function describeFailure(error: { code: string; reason?: string } | undefined, content: readonly ContentBlock[]): Outcome {
  const code = error?.code
  if (!code || !Object.hasOwn(FAILURE_REASONS, code)) return { status: 'failed', reason: 'Tool call failed' }
  let reason = FAILURE_REASONS[code]!
  if (code === 'FS_NOT_FOUND') {
    const only = content.length === 1 ? content[0] : undefined
    const text = error.reason ?? (only?.type === 'text' ? only.text : '')
    if (text.length <= 8192 && /^(?:Error: )?cannot (?:read|write|edit) "[^\r\n]*": not found$/.test(text)) reason = 'File not found'
    if (text.length <= 8192 && /^(?:Error: )?offset \d+ is out of range for /.test(text)) reason = 'Requested file position was out of range'
  }
  return { status: CANCEL_CODES.has(code) ? 'cancelled' : 'failed', code, reason }
}

function describeBash(value: unknown): Outcome {
  // The pinned bash tool exposes the executed command's status here. Its
  // rendered stdout could itself contain an apparent exit marker.
  const result = record(value)
  if (result?.kind !== 'foreground') return { status: 'unknown' }
  if (record(result.sandbox)?.denied === true) return { status: 'failed', reason: 'Sandbox denied the command' }
  if (result.timedOut === true) return { status: 'failed', reason: 'Command timed out' }
  if (result.aborted === true) return { status: 'cancelled', reason: 'Tool call cancelled' }
  if (typeof result.signal === 'string' || typeof result.stopped === 'string') return { status: 'failed', reason: 'Command was stopped' }
  const exit = result.exitCode
  if (typeof exit !== 'number' || !Number.isInteger(exit) || exit < 0 || exit > 255) return { status: 'unknown' }
  if (exit === 0) return { status: 'unknown' }
  return { status: 'failed', code: `EXIT_${exit}`, reason: `Command exited with code ${exit}` }
}

function validEntry(value: unknown): value is Entry {
  const entry = record(value)
  const event = record(entry?.event)
  if (!entry || !event || Object.keys(entry).some(key => key !== 'session' && key !== 'event')) return false
  if (Object.keys(event).some(key => !['seq', 'turn', 'tool', 'status', 'target', 'code', 'reason'].includes(key))) return false
  const { seq, turn, tool, status, target, code, reason } = event
  const exit = typeof code === 'string' ? /^EXIT_([1-9]\d{0,2})$/.exec(code) : null
  return typeof entry.session === 'string' && SESSION.test(entry.session)
    && typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0
    && typeof turn === 'number' && Number.isSafeInteger(turn) && turn > 0
    && typeof tool === 'string' && TOOL.test(tool) && !IGNORE_TOOLS.has(tool)
    && (status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'unknown')
    && (target === undefined || (FILE_TOOLS.has(tool) && safeTarget(target)))
    && (code === undefined || (typeof code === 'string' && Object.hasOwn(FAILURE_REASONS, code))
      || (exit !== null && Number(exit[1]) <= 255 && tool === 'bash' && status === 'failed'))
    && (reason === undefined || (typeof reason === 'string' && (SAFE_REASONS.has(reason) || (exit !== null && reason === `Command exited with code ${exit[1]}`))))
}

function keyOf(entry: Entry): string { return `${entry.session}/${entry.event.seq}` }

class Outbox {
  private staged = new Map<string, Entry>()
  private entries: Entry[] = []
  private owner?: string
  private initialized = false
  private disk = Promise.resolve()
  private pendingWrite = false
  private sending = false
  private disposed = false
  private timer: NodeJS.Timeout | undefined
  private retry = 0
  private sessionCursor: string | undefined
  private readonly lifetime = new AbortController()

  constructor(
    private readonly path: string,
    private readonly origin: string,
    private readonly endpoint: URL,
    private readonly account: Account,
    private readonly warn: (message: string) => void,
  ) { this.persist() }

  add(entry: Entry): void {
    if (this.disposed || !validEntry(entry)) return
    if (this.staged.size + this.entries.length >= MAX_BACKLOG) {
      this.warn('Tool observation outbox is full')
      return
    }
    this.staged.set(keyOf(entry), entry)
    this.persist()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort()
    clearTimeout(this.timer)
    await this.disk
    this.persist()
    await this.disk
  }

  private accountOwner(): string | undefined {
    const profile = this.account.status().profile
    return profile ? createHash('sha256').update(JSON.stringify([this.origin, profile.organizationId, profile.userId])).digest('hex') : undefined
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    await this.account.restore()
    const owner = this.accountOwner()
    if (!owner) throw new Error('account unavailable')
    const file = await lstat(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (file) {
      if (!file.isFile() || file.size > MAX_OUTBOX_BYTES || (process.platform !== 'win32' && (file.mode & 0o077) !== 0)) throw new Error('unsafe outbox')
      const saved = record(JSON.parse(await readFile(this.path, 'utf8')))
      if (!saved || saved.owner !== owner || !Array.isArray(saved.entries) || saved.entries.length > MAX_BACKLOG || !saved.entries.every(validEntry)) throw new Error('invalid outbox')
      this.entries = saved.entries
    }
    this.owner = owner
    this.initialized = true
  }

  private async save(entries: Entry[]): Promise<void> {
    const tmp = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify({ owner: this.owner, entries }), { mode: 0o600, flag: 'wx', flush: true })
      await rename(tmp, this.path)
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
    this.entries = entries
  }

  private persist(): void {
    if (this.pendingWrite || (this.initialized && this.staged.size === 0)) return
    this.pendingWrite = true
    this.disk = this.disk.then(async () => {
      await this.initialize()
      const staged = this.staged
      this.staged = new Map()
      try {
        const entries = new Map(this.entries.map(entry => [keyOf(entry), entry]))
        for (const [key, entry] of staged) if (!entries.has(key)) entries.set(key, entry)
        if (entries.size > MAX_BACKLOG) this.warn('Tool observation outbox is full')
        if (entries.size !== this.entries.length) await this.save([...entries.values()].slice(0, MAX_BACKLOG))
      } catch (error) {
        this.staged = new Map([...staged, ...this.staged].slice(0, MAX_BACKLOG))
        throw error
      }
    }).then(() => {
      this.pendingWrite = false
      if (!this.disposed && this.staged.size > 0) this.persist()
      if (this.entries.length > 0) this.schedule()
    }, () => {
      this.pendingWrite = false
      this.warn('Tool observation outbox could not be saved')
      this.schedule(true)
    })
  }

  private schedule(failed = false): void {
    if (this.disposed || this.timer) return
    if (failed) this.retry = Math.min(60_000, this.retry * 2 || 1000)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.persist()
      void this.send()
    }, this.retry)
    this.timer.unref()
  }

  private async send(): Promise<void> {
    if (this.disposed || this.sending || this.entries.length === 0) return
    this.sending = true
    try {
      const sessions = [...new Set(this.entries.map(entry => entry.session))]
      const session = sessions[(sessions.indexOf(this.sessionCursor ?? '') + 1) % sessions.length]!
      this.sessionCursor = session
      const batch = this.entries.filter(entry => entry.session === session).slice(0, MAX_BATCH)
      const token = await this.account.getValidAccessToken()
      if (this.accountOwner() !== this.owner) throw new Error('account changed')
      const response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session, events: batch.map(entry => entry.event) }),
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(12_000)]),
      })
      if (response.status !== 204) {
        void response.body?.cancel().catch(() => undefined)
        throw new Error('observation batch not acknowledged')
      }
      const sent = new Set(batch.map(keyOf))
      const acknowledge = this.disk.then(() => this.save(this.entries.filter(entry => !sent.has(keyOf(entry)))))
      this.disk = acknowledge.catch(() => undefined)
      await acknowledge
      this.retry = 0
      if (this.entries.length > 0) this.schedule()
    } catch {
      if (!this.disposed) this.warn('Tool observation delivery will be retried')
      clearTimeout(this.timer)
      this.timer = undefined
      this.schedule(true)
    } finally { this.sending = false }
  }
}

export function installToolObservations(
  ctx: Context,
  companyOrigin: string,
  account: Account = new WebAccountBroker({ publicOrigin: companyOrigin }),
): void {
  const home = process.env.DSH_HOME
  if (!home || !isAbsolute(home)) {
    ctx.logger.warn('Tool observations require an absolute DSH_HOME')
    return
  }
  const endpoint = new URL('/dsh/employee-memory/observations', companyOrigin)
  const outbox = new Outbox(join(home, '.p7-tool-observations.json'), companyOrigin, endpoint, account, message => ctx.logger.warn(message))
  const active = new WeakMap<Session, ActiveTurn>()
  ctx.effect(() => () => outbox.dispose(), 'Tool observation outbox')

  ctx.on('tools/result', (exec, result) => {
    const session = exec.agent?.session
    if (!session || exec.name !== 'bash' || result.isError) return undefined
    const turn = active.get(session)
    const call = (exec.parent === undefined ? turn?.calls : turn?.nested)?.get(exec.callId)
    if (call?.tool === 'bash' && (!call.ptc || call.ptc.root === exec.rootCallId)) call.shell = describeBash(result.value)
    return undefined
  })

  ctx.on('session/event', (session, event) => {
    if (session.header.origin === 'subagent' || !SESSION.test(session.id)) return
    if (event.type === 'turn/start') {
      active.set(session, { turn: event.data.turn, calls: new Map(), nested: new Map() })
      return
    }
    if (event.type === 'turn/end') {
      active.delete(session)
      return
    }
    const turn = active.get(session)
    if (!turn) return
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const native = event.type === 'tool/call'
      const calls = native ? turn.calls : turn.nested
      if (native && event.data.turn !== turn.turn) return
      const { name, arguments: args } = event.data
      if (calls.size >= MAX_CALLS_PER_TURN || !TOOL.test(name) || IGNORE_TOOLS.has(name)) return
      const target = targetFor(name, args)
      calls.set(native ? event.data.callId : event.data.subCallId, {
        seq: event.seq, tool: name, ...(target ? { target } : {}),
        ...(native ? {} : { ptc: { root: event.data.rootCallId, parent: event.data.parentCallId } }),
      })
      return
    }
    if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return
    const native = event.type === 'tool/result'
    const calls = native ? turn.calls : turn.nested
    const id = native ? event.data.message.toolCallId : event.data.subCallId
    const call = calls.get(id)
    if (!call || event.seq <= call.seq) return
    if (native) {
      if (event.data.turn !== turn.turn || event.surfaceOp !== 'append' || !event.sourceEventSeqs?.includes(call.seq)) return
    } else if (event.data.name !== call.tool || event.data.rootCallId !== call.ptc?.root || event.data.parentCallId !== call.ptc?.parent) return
    calls.delete(id)
    const result = native ? event.data.message : event.data
    const outcome = result.isError ? describeFailure(event.data.error, result.content)
      : call.tool === 'bash' ? call.shell ?? { status: 'unknown' } as const : { status: 'succeeded' } as const
    outbox.add({ session: session.id, event: { seq: event.seq, turn: turn.turn, tool: call.tool, ...(call.target ? { target: call.target } : {}), ...outcome } })
  })
}
