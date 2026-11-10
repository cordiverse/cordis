import { Context } from 'cordis'

export interface Config {
  enabled?: boolean
  autoRestart?: boolean
  heartbeatInterval?: number
  heartbeatTimeout?: number
  exitTimeout?: number
}

export const name = 'daemon'

// errors raised by writing to an IPC channel whose peer has gone
const closedErrors = ['EPIPE', 'ECONNRESET', 'ERR_IPC_CHANNEL_CLOSED']

export function* apply(ctx: Context, config: Config = {}) {
  let exiting = false

  // `process.send` is undefined when the worker is not forked with an IPC channel
  function send(message: any) {
    // A callback receives write errors that would otherwise be emitted on `process`.
    // `process.connected` may still be true when the peer has already closed.
    process.send?.(message, (error: any) => {
      if (!error || closedErrors.includes(error.code)) return
      ctx.logger.warn(error)
    })
  }

  function exit(signal: NodeJS.Signals, reason: string) {
    if (exiting) return
    exiting = true
    // an `exit` listener that never settles must not keep the worker alive
    setTimeout(() => process.exit(1), config.exitTimeout ?? 10000).unref()
    ctx.logger.info(reason)
    ctx.parallel('exit', signal).finally(() => process.exit())
  }

  function handleSignal(signal: NodeJS.Signals) {
    process.stderr.write('\x1b[2K\r')
    // the parent process must not restart a worker that is exiting on request,
    // regardless of the exit code produced by the cleanup
    send({ type: 'exit' })
    exit(signal, `terminated by ${signal}`)
  }

  // the parent process has exited, so no one supervises or restarts this worker
  function handleDisconnect() {
    exit('SIGHUP', 'parent process disconnected')
  }

  process.on('SIGINT', handleSignal)
  yield () => process.off('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)
  yield () => process.off('SIGTERM', handleSignal)
  process.on('disconnect', handleDisconnect)
  yield () => process.off('disconnect', handleDisconnect)

  // `disconnect` is not emitted again for a channel that closed before the
  // listener was registered, such as during module loading or preloading
  if (process.send && !process.connected) {
    handleDisconnect()
    return
  }

  send({ type: 'start', body: config })
  if (config.heartbeatInterval) {
    const timer = setInterval(() => {
      send({ type: 'heartbeat' })
    }, config.heartbeatInterval)
    yield () => clearInterval(timer)
  }
}
