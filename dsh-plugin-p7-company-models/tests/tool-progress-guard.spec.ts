import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolProgressGuard, installToolProgressGuard } from '../src/tool-progress-guard.js'

const success = (text: string) => ({ isError: false, content: [{ type: 'text', text }] })
const failure = (text: string) => ({ isError: true, content: [{ type: 'text', text }], error: { message: text } })

describe('ToolProgressGuard', () => {
  it('pauses alternating repeated fingerprints but does not retain output text', () => {
    const guard = new ToolProgressGuard({ patternWindow: 4, repeatedPatternThreshold: 4 })
    expect(guard.observe('read', { path: 'a' }, success('same-a'))).toBe(false)
    expect(guard.observe('web', { url: 'https://invalid.example' }, failure('404'))).toBe(false)
    expect(guard.observe('read', { path: 'a' }, success('same-a'))).toBe(false)
    expect(guard.observe('web', { url: 'https://invalid.example' }, failure('404'))).toBe(true)
    expect(JSON.stringify(guard)).not.toContain('same-a')
    expect(JSON.stringify(guard)).not.toContain('invalid.example')
  })

  it('treats paginated 404s as one failing target but permits distinct successful pages', () => {
    const errors = new ToolProgressGuard({ repeatedErrorThreshold: 3 })
    expect(errors.observe('web', { url: 'https://invalid.example/search', page: 1 }, failure('404 page 1'))).toBe(false)
    expect(errors.observe('web', { url: 'https://invalid.example/search', page: 2 }, failure('404 page 2'))).toBe(false)
    expect(errors.observe('web', { url: 'https://invalid.example/search', page: 3 }, failure('404 page 3'))).toBe(true)

    const pages = new ToolProgressGuard({ patternWindow: 4, repeatedPatternThreshold: 4 })
    for (const page of [1, 2, 3, 4, 5]) expect(pages.observe('web', { query: 'news', page }, success(`page ${page}`))).toBe(false)
  })

  it('does not pause legitimate distinct work or configured long-poll style tools', () => {
    const guard = new ToolProgressGuard({ patternWindow: 4, repeatedPatternThreshold: 4 })
    for (const index of [1, 2, 3, 4, 5, 6]) expect(guard.observe('read', { path: `file-${index}` }, success(`result-${index}`))).toBe(false)
    for (const index of [1, 2, 3, 4, 5]) expect(guard.observe('status_poll', { job: 'slow' }, success(`tick-${index}`))).toBe(false)
  })
})

describe('plugin adapter', () => {
  it('uses a hook cancellation, preserves the post-execute decision, and resets on a user cancellation boundary', async () => {
    const ctx = new Context()
    installToolProgressGuard(ctx, { patternWindow: 2, repeatedPatternThreshold: 2 })
    const agent = { cancel: vi.fn() }
    const events = ctx as unknown as { waterfall: (...args: unknown[]) => Promise<unknown> }
    const execute = async () => events.waterfall('tools/post-execute',
      { agent, name: 'read', arguments: { path: 'same' } } as never,
      success('same') as never,
      () => Promise.resolve({ kind: 'accept' }))
    await execute()
    expect(agent.cancel).not.toHaveBeenCalled()
    await execute()
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'P7 tool loop paused after repeated no-progress executions.' })
    await events.waterfall('agent/status', { agent, status: 'idle' })
    await execute()
    expect(agent.cancel).toHaveBeenCalledTimes(1)
  })
})
