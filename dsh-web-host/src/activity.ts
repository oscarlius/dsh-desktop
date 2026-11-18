import type { Context } from '@deepseek-ai/cordis'

export interface WebActivitySnapshot {
  /** `unknown` deliberately blocks controller stop/update decisions. */
  state: 'unknown' | 'idle' | 'busy'
  activeAgents: number
  observedAt: string | null
}

export interface WebActivityProbe { snapshot(): WebActivitySnapshot; inspect(): Promise<WebActivitySnapshot> }
interface LiveAgent { status?: unknown; whenIdle(): Promise<void> }

/**
 * Controller-facing activity evidence. It observes the documented Host agent
 * lifecycle only; missing lifecycle evidence remains busy/unknown.
 */
export class AgentActivityProbe implements WebActivityProbe {
  constructor(private readonly registry?: () => readonly LiveAgent[] | undefined) {}
  private readonly active = new Set<object>()
  private observedAt: string | null = null
  private observed = false
  observe(agent: object, status: unknown): void {
    this.observed = true
    if (status === 'idle') this.active.delete(agent)
    else this.active.add(agent)
    this.observedAt = new Date().toISOString()
  }
  /** A successful registry read is trustworthy evidence even when it is empty. */
  observeRegistry(): void {
    this.observed = true
    this.observedAt = new Date().toISOString()
  }
  snapshot(): WebActivitySnapshot {
    if (!this.observed) return { state: 'unknown', activeAgents: 0, observedAt: null }
    return { state: this.active.size ? 'busy' : 'idle', activeAgents: this.active.size, observedAt: this.observedAt }
  }
  async inspect(): Promise<WebActivitySnapshot> {
    // Public status stays idle during maintenance. Only whenIdle can prove
    // whole-agent inactivity; it is a point-in-time probe, not a drain barrier.
    try {
      const agents = this.registry?.()
      if (!agents) return { state: 'unknown', activeAgents: 0, observedAt: null }
      if (agents.some(agent => agent.status !== 'idle')) return { state: 'busy', activeAgents: agents.length, observedAt: new Date().toISOString() }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const idle = await Promise.race([
          Promise.all(agents.map(agent => agent.whenIdle())).then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 20) }),
        ])
        const current = this.registry?.()
        const unchanged = current?.length === agents.length && current.every((agent,index) => agent === agents[index] && agent.status === 'idle')
        return { state: idle && unchanged ? 'idle' : 'busy', activeAgents: idle && unchanged ? 0 : agents.length, observedAt: new Date().toISOString() }
      } finally { if (timer) clearTimeout(timer) }
    } catch { return { state: 'unknown', activeAgents: 0, observedAt: null } }
  }
}

declare module '@deepseek-ai/cordis' { interface Context { p7WebActivity: WebActivityProbe } }

export function installAgentActivityProbe(ctx: Context): WebActivityProbe {
  const readRegistry = () => (ctx as unknown as { agents?: { list(): readonly LiveAgent[] } }).agents?.list()
  const probe = new AgentActivityProbe(readRegistry)
  // Once the official registry exists, its empty collection is trustworthy
  // idle evidence. Before that service is available we intentionally remain
  // unknown rather than conflating startup with no active work.
  const agents = (ctx as unknown as { agents?: { list(): readonly (object & { status?: unknown })[] } }).agents
  if (agents) {
    for (const agent of agents.list()) probe.observe(agent, agent.status)
    probe.observeRegistry()
  }
  ctx.provide('p7WebActivity', probe)
  // The official agent event is optional in the web-only type surface. Keep
  // the runtime subscription narrow rather than claiming idle without it.
  ctx.on('agent/status' as never, (({ agent, status }: { agent: object; status: unknown }) => probe.observe(agent, status)) as never)
  return probe
}
