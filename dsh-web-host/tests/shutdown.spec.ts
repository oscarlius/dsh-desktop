import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { forwardShutdownSignals } from '../src/shutdown.js'

class FakeProcess extends EventEmitter { exitCode: number | string | null | undefined }
class FakeChild extends EventEmitter { kill = vi.fn((_signal: NodeJS.Signals) => true) }

describe('forwardShutdownSignals', () => {
  it('forwards SIGTERM only once and does not set an exit code before the child exits', () => {
    const process = new FakeProcess(), child = new FakeChild()
    forwardShutdownSignals(process, child as never)
    process.emit('SIGTERM'); process.emit('SIGINT')
    expect(child.kill).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(process.exitCode).toBeUndefined()
    child.emit('exit', null, 'SIGTERM')
    expect(process.exitCode).toBe(0)
  })

  it('cleans signal listeners and preserves a nonzero child exit code', () => {
    const process = new FakeProcess(), child = new FakeChild()
    forwardShutdownSignals(process, child as never)
    process.emit('SIGTERM'); child.emit('exit', 7, null)
    expect(process.exitCode).toBe(7)
    expect(process.listenerCount('SIGTERM')).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(0)
    process.emit('SIGTERM')
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('fails an unexpected child signal', () => {
    const process = new FakeProcess(), child = new FakeChild()
    forwardShutdownSignals(process, child as never)
    child.emit('exit', null, 'SIGKILL')
    expect(process.exitCode).toBe(1)
  })

  it('does not report a forced kill as a successful requested shutdown', () => {
    const process = new FakeProcess(), child = new FakeChild()
    forwardShutdownSignals(process, child as never)
    process.emit('SIGTERM'); child.emit('exit', null, 'SIGKILL')
    expect(process.exitCode).toBe(1)
  })
})
