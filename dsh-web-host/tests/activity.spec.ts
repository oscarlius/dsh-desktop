import { describe, expect, it } from 'vitest'
import { AgentActivityProbe } from '../src/activity.js'

describe('controller activity evidence', () => {
  it('fails closed until a real Host lifecycle event is observed', () => {
    const probe = new AgentActivityProbe()
    expect(probe.snapshot()).toMatchObject({ state: 'unknown', activeAgents: 0 })
  })

  it('does not treat a running agent as idle before its terminal lifecycle event', () => {
    const probe = new AgentActivityProbe(); const agent = {}
    probe.observe(agent, 'running')
    expect(probe.snapshot()).toMatchObject({ state: 'busy', activeAgents: 1 })
    probe.observe(agent, 'idle')
    expect(probe.snapshot()).toMatchObject({ state: 'idle', activeAgents: 0 })
  })

  it('recognizes a successfully observed empty registry as idle', () => {
    const probe = new AgentActivityProbe()
    probe.observeRegistry()
    expect(probe.snapshot()).toMatchObject({ state: 'idle', activeAgents: 0 })
  })

  it('does not mistake an idle-status maintenance operation for inactivity', async () => {
    let settle!: () => void
    const maintenance = new Promise<void>(resolve => { settle=resolve })
    const agent = { status: 'idle', whenIdle: () => maintenance }
    const probe = new AgentActivityProbe(() => [agent])
    expect(await probe.inspect()).toMatchObject({state:'busy'})
    settle()
    expect(await probe.inspect()).toMatchObject({state:'idle'})
  })

  it('observes late registry availability and fails closed on read failure', async () => {
    let registry: [] | undefined
    const probe = new AgentActivityProbe(() => registry)
    expect(await probe.inspect()).toMatchObject({state:'unknown'})
    registry=[]
    expect(await probe.inspect()).toMatchObject({state:'idle'})
    expect(await new AgentActivityProbe(() => { throw new Error('registry unavailable') }).inspect()).toMatchObject({state:'unknown'})
  })
})
