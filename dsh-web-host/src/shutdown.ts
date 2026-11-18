import type { ChildProcess } from 'node:child_process'

type Signal = 'SIGTERM' | 'SIGINT'
type ProcessSignals = {
  exitCode: number | string | null | undefined
  on(signal: Signal, listener: () => void): unknown
  off(signal: Signal, listener: () => void): unknown
}
type ChildSignals = Pick<ChildProcess, 'kill' | 'on' | 'off'>

/** Forward the container stop signal once and let the official child flush/exit. */
export function forwardShutdownSignals(process: ProcessSignals, child: ChildSignals): void {
  let forwarded: Signal | undefined
  const stop = (signal: Signal) => {
    if (forwarded) return
    forwarded = signal
    child.kill(signal)
  }
  const term = () => stop('SIGTERM')
  const interrupt = () => stop('SIGINT')
  const exited = (code: number | null, signal: NodeJS.Signals | null) => {
    process.off('SIGTERM', term)
    process.off('SIGINT', interrupt)
    child.off('exit', exited)
    process.exitCode = code ?? (signal === forwarded ? 0 : 1)
  }
  process.on('SIGTERM', term)
  process.on('SIGINT', interrupt)
  child.on('exit', exited)
}
