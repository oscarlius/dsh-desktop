import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'p7-agent-contract-guard': { kind: 'p7-agent-contract-guard' } & ContextFormed
  }
}

const MAX_INVALID_CALLS = 3

interface TurnState {
  turn: number
  invalidCalls: number
  unresolvedTools: Set<string>
  pendingTodos: number
  continued: boolean
  suspended: boolean
  normalStop: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function invalidArguments(result: ToolExecutionResult): boolean {
  return result.isError && result.error.info?.code === 'INVALID_ARGS'
}

function notice(summary: string, text: string) {
  return createUserMessage({
    source: { kind: 'p7-agent-contract-guard', form: 'notice', summary },
    content: [{ type: 'text', text }],
  })
}

function correction(ctx: Context, exec: ToolExecution): string {
  const args = record(exec.arguments)
  const schema = ctx.tools.get(exec.name, exec.agent)?.parameters
  const field = record(record(schema?.properties)?.sandbox_permissions)
  // Only explain omission when the CURRENT visible schema proves it is optional
  // and the foreign sentinel is invalid. Never select an escalation on behalf of a user.
  const omitDefault = args?.sandbox_permissions === 'use_default'
    && field !== undefined && Array.isArray(field.enum) && !field.enum.includes('use_default')
    && !(Array.isArray(schema?.required) && schema.required.includes('sandbox_permissions'))
  return `工具 ${exec.name} 的参数校验失败，原调用未被本保护改写。请根据上一条错误和当前工具 schema 修正后重新调用；不要猜测业务参数或提高权限。`
    + (omitDefault ? ' sandbox_permissions 是可选字段；沿用现有权限时请省略该字段，不能填写 use_default，也不能改成更高权限。' : '')
    + ' 若缺少必须由用户提供的信息、用户已要求停止或当前操作需要新的授权，请说明具体阻塞并等待；否则继续已授权任务。'
}

/** Bounded recovery on public RC1 hooks; no tool replay or argument mutation. */
export function installAgentContractGuard(ctx: Context): void {
  const states = new WeakMap<Agent, TurnState>()
  ctx.on('agent/pre-step', async ({ agent, turn, messages }, next) => {
    let state = states.get(agent)
    if (!state || state.turn !== turn) {
      state = { turn, invalidCalls: 0, unresolvedTools: new Set(), pendingTodos: 0, continued: false, suspended: false, normalStop: false }
      states.set(agent, state)
    }
    // The native stop button aborts the signal. Also leave explicit text stops
    // alone; ordinary language/status steering must not reset the recovery budget.
    for (const message of messages) {
      if (message.source.kind !== 'user') continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
      if (/^(?:请|先|现在|please\s+)?(?:停止|停下|暂停|取消|不要继续|别继续|不用继续|不必继续|stop\b|pause\b|cancel\b|don't continue\b)/iu.test(text)) state.suspended = true
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const state = exec.agent && states.get(exec.agent)
    if (!state || state.suspended || exec.signal.aborted || decision.kind !== 'accept'
      || !invalidArguments(result) || state.invalidCalls >= MAX_INVALID_CALLS - 1) return decision
    return { ...decision, additionalContexts: [...decision.additionalContexts ?? [],
      notice('工具参数需要修正', correction(ctx, exec))] }
  })

  // Observe the final immutable result, including policy denials and replacements.
  // Post-execute alone is not authoritative and may not run on pre-dispatch denial.
  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    const state = agent && states.get(agent)
    if (!agent || !state || exec.signal.aborted) return
    if (invalidArguments(result)) {
      state.unresolvedTools.add(exec.name)
      state.invalidCalls++
      if (!state.suspended && state.invalidCalls >= MAX_INVALID_CALLS) {
        agent.cancel({ kind: 'hook', reason: 'P7 paused after 3 invalid tool calls in one turn; task remains incomplete.' })
      }
    } else if (result.isError || result.concludesTurn) {
      // Permission denial, cancellation, human-question/concluding tools, and
      // non-schema failures retain their normal stop boundary.
      state.suspended = true
    } else {
      state.unresolvedTools.delete(exec.name)
      if (exec.name === 'todo_write') {
        const todos = record(result.value)?.todos
        state.pendingTodos = Array.isArray(todos) && todos.every(item => {
          const todo = record(item)
          return typeof todo?.content === 'string' && ['pending', 'in_progress', 'completed'].includes(String(todo.status))
        }) ? todos.filter(item => record(item)?.status !== 'completed').length : 0
      }
    }
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const state = states.get(agent)
    if (!state) return
    if (frame.type === 'start') state.normalStop = false
    if (frame.type === 'chunk' && frame.chunk.type === 'finish') {
      state.normalStop = frame.chunk.reason.kind === 'stop'
      if (frame.chunk.reason.kind === 'max-tokens') state.suspended = true
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const state = states.get(agent)
    if (!state || state.turn !== turn || state.suspended || !state.normalStop || signal.aborted
      || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0
      || (state.unresolvedTools.size === 0 && state.pendingTodos === 0)) return
    if (state.continued) {
      agent.cancel({ kind: 'hook', reason: 'P7 task remains incomplete after one continuation; review unresolved tool arguments or todos.' })
      return
    }
    state.continued = true
    agent.steer(notice('任务尚有未完成事项，继续核对一次',
      `本轮仍有 ${state.unresolvedTools.size} 个工具的参数错误未解决、${state.pendingTodos} 项待办未完成。`
      + '请先遵守最新用户指示；语言或进度询问本身不撤销原任务。若任务仍获授权且可继续，请修正调用或完成下一步，不要再次询问是否继续。'
      + '若事项已完成或已被用户取消，请据实更新待办；不要为通过检查虚报完成。若需要用户信息、权限或外部条件，请说明具体阻塞并等待。'
      + '这是本轮唯一一次自动继续提醒。'))
  })

  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') states.delete(agent) })
}
