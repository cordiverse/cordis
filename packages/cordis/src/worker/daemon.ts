import { Context } from '../index.ts'

export interface Config {
  autoRestart?: boolean
  heartbeatInterval?: number
  heartbeatTimeout?: number
}

export const name = 'daemon'

export function apply(ctx: Context, config: Config = {}) {
  function handleSignal(signal: NodeJS.Signals) {
    // prevent restarting when child process is exiting
    if (config.autoRestart) {
      process.send!({ type: 'exit' })
    }
    ctx.emit(ctx, 'internal/info', `terminated by ${signal}`)
    ctx.parallel('exit', signal).finally(() => process.exit())
  }

  ctx.effect(function* () {
    process.on('SIGINT', handleSignal)
    yield () => process.off('SIGINT', handleSignal)
    process.on('SIGTERM', handleSignal)
    yield () => process.off('SIGTERM', handleSignal)
  }, 'process.on(signal)')

  process.send!({ type: 'start', body: config })
  config.heartbeatInterval && setInterval(() => {
    process.send!({ type: 'heartbeat' })
  }, config.heartbeatInterval)
}
