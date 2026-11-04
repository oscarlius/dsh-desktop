import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

export interface ToolProgressGuardConfig {
  patternWindow?: number
  maxDistinctPatterns?: number
  repeatedPatternThreshold?: number
  repeatedErrorThreshold?: number
  ignoreToolNamePatterns?: string[]
}

interface ToolResultLike {
  isError: boolean
  content: unknown
  error?: unknown
  value?: unknown
}

interface ToolExecutionLike {
  agent?: { cancel(cause: { kind: 'hook'; reason: string }): void }
  name: string
  arguments: unknown
}

interface GuardEvent {
  toolName: string
  fingerprint: string
  errorTarget: string | undefined
}

const DEFAULT_PATTERN_WINDOW = 8
const DEFAULT_MAX_DISTINCT_PATTERNS = 2
const DEFAULT_REPEATED_ERROR_THRESHOLD = 4
const DEFAULT_IGNORED_TOOLS = ['*poll*', '*watch*', '*stream*', '*subscribe*']
const PAGINATION_ARGUMENTS = /^(?:page|pageNumber|pageIndex|offset|cursor|nextCursor|limit|perPage|pageSize)$/i

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  const rendered = JSON.stringify(value)
  return rendered === undefined ? 'undefined' : rendered
}

function withoutPagination(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPagination)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !PAGINATION_ARGUMENTS.test(key))
      .map(([key, child]) => [key, withoutPagination(child)]))
  }
  return value
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`, 'i').test(name)
}

/** Pure per-agent, per-turn no-progress detector. It stores only SHA-256 fingerprints. */
export class ToolProgressGuard {
  private readonly patternWindow: number
  private readonly maxDistinctPatterns: number
  private readonly repeatedPatternThreshold: number
  private readonly repeatedErrorThreshold: number
  private readonly ignoredPatterns: string[]
  private readonly events: GuardEvent[] = []
  private errorTarget: string | undefined
  private errorCount = 0

  constructor(config: ToolProgressGuardConfig = {}) {
    this.patternWindow = config.patternWindow ?? DEFAULT_PATTERN_WINDOW
    this.maxDistinctPatterns = config.maxDistinctPatterns ?? DEFAULT_MAX_DISTINCT_PATTERNS
    this.repeatedPatternThreshold = config.repeatedPatternThreshold ?? this.patternWindow
    this.repeatedErrorThreshold = config.repeatedErrorThreshold ?? DEFAULT_REPEATED_ERROR_THRESHOLD
    this.ignoredPatterns = config.ignoreToolNamePatterns ?? DEFAULT_IGNORED_TOOLS
    for (const [name, value, minimum] of [
      ['patternWindow', this.patternWindow, 2],
      ['maxDistinctPatterns', this.maxDistinctPatterns, 1],
      ['repeatedPatternThreshold', this.repeatedPatternThreshold, 2],
      ['repeatedErrorThreshold', this.repeatedErrorThreshold, 2],
    ] as const) {
      if (!Number.isInteger(value) || value < minimum) throw new Error(`tool-progress-guard: ${name} must be an integer >= ${minimum}`)
    }
    if (this.maxDistinctPatterns > this.patternWindow) throw new Error('tool-progress-guard: maxDistinctPatterns must not exceed patternWindow')
  }

  observe(toolName: string, argumentsValue: unknown, result: ToolResultLike): boolean {
    if (this.ignoredPatterns.some(pattern => matchesPattern(toolName, pattern))) return false
    const fingerprint = digest([toolName, argumentsValue, result.isError, result.content, result.error, result.value])
    const errorTarget = result.isError ? digest([toolName, withoutPagination(argumentsValue)]) : undefined
    this.events.push({ toolName, fingerprint, errorTarget })
    if (this.events.length > this.patternWindow) this.events.shift()

    if (errorTarget === undefined) {
      this.errorTarget = undefined
      this.errorCount = 0
    } else if (this.errorTarget === errorTarget) {
      this.errorCount++
    } else {
      this.errorTarget = errorTarget
      this.errorCount = 1
    }

    const repeatedPattern = this.events.length >= this.repeatedPatternThreshold
      && new Set(this.events.map(event => event.fingerprint)).size <= this.maxDistinctPatterns
    return repeatedPattern || this.errorCount >= this.repeatedErrorThreshold
  }
}

type PostExecuteListener = (exec: ToolExecutionLike, result: ToolResultLike, next: () => Promise<unknown>) => Promise<unknown>
type EventHost = {
  on(event: 'tools/post-execute', listener: PostExecuteListener): unknown
  on(event: 'agent/pre-step', listener: (event: { agent: object; messages: Array<{ source: { kind: string } }> }, next: () => Promise<unknown>) => Promise<unknown>): unknown
  on(event: 'agent/status', listener: (event: { agent: object; status: string }) => void): unknown
}

/** Mount the public hook-cancellation control point without changing tool results. */
export function installToolProgressGuard(ctx: Context, config: ToolProgressGuardConfig = {}): void {
  const guards = new WeakMap<object, ToolProgressGuard>()
  const events = ctx as unknown as EventHost
  events.on('tools/post-execute', async (exec, result, next) => {
    const agent = exec.agent
    if (agent !== undefined) {
      let guard = guards.get(agent)
      if (guard === undefined) {
        guard = new ToolProgressGuard(config)
        guards.set(agent, guard)
      }
      if (guard.observe(exec.name, exec.arguments, result)) {
        guards.delete(agent)
        // Agent.cancel is the public driver control: the current result still
        // commits, then the turn records a non-user hook stop with its history intact.
        agent.cancel({ kind: 'hook', reason: 'P7 tool loop paused after repeated no-progress executions.' })
      }
    }
    return next()
  })
  events.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (messages.some(message => message.source.kind === 'user')) guards.delete(agent)
    return next()
  })
  // Idle follows both ordinary completion and every public cancellation cause,
  // including a real user cancellation; no detector state crosses a turn.
  events.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') guards.delete(agent)
  })
}
