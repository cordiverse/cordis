import { Context, Service } from '@cordisjs/core'
import { defineProperty, hyphenate, remove } from 'cosmokit'
import Reggol from 'reggol'

export { Reggol as Logger }

declare module '@cordisjs/core' {
  interface Context {
    logger: Logger
  }

  interface Intercept {
    logger: Logger.Intercept
  }
}

declare module 'reggol' {
  namespace Logger {
    interface Meta {
      ctx?: Context
    }
  }
}

namespace Logger {
  export interface Config {
    showDiff?: boolean
    showTime?: string | boolean
  }

  export interface Intercept {
    name?: string
  }
}

interface Logger extends Pick<Reggol, Reggol.Type> {
  (name: string): Reggol
}

class Logger extends Service {
  buffer: Reggol.Record[] = []

  constructor(ctx: Context, config: Logger.Config = {}) {
    super(ctx, 'logger')

    const appLogger = new Reggol('app')

    ctx.on('internal/info', (format, ...args) => {
      appLogger.info(format, ...args)
    })

    ctx.on('internal/error', (format, ...args) => {
      appLogger.error(format, ...args)
    })

    ctx.on('internal/warning', (format, ...args) => {
      appLogger.warn(format, ...args)
    })

    process.on('uncaughtException', (error) => {
      appLogger.error(error)
      process.exitCode = 1
    })

    process.on('unhandledRejection', (error) => {
      appLogger.warn(error)
    })

    let showTime = config.showTime
    if (showTime === true) showTime = 'yyyy-MM-dd hh:mm:ss'
    if (showTime) Reggol.targets[0].showTime = showTime
    Reggol.targets[0].showDiff = config.showDiff
    Reggol.targets[0].timestamp = Date.now()

    const target: Reggol.Target = {
      colors: 3,
      record: (record) => {
        this.buffer.push(record)
        this.buffer = this.buffer.slice(-1000)
      },
    }
    Reggol.targets.push(target)
    ctx.on('dispose', () => {
      remove(Reggol.targets, target)
    })
  }

  [Service.invoke](name: string) {
    return new Reggol(name, defineProperty({}, 'ctx', this.ctx))
  }

  static {
    for (const type of ['success', 'error', 'info', 'warn', 'debug']) {
      Logger.prototype[type] = function (this: Logger, ...args: any[]) {
        let config: Logger.Intercept = {}
        let intercept = this.ctx[Context.intercept]
        while (intercept) {
          config = Object.assign({}, intercept.logger, config)
          intercept = Object.getPrototypeOf(intercept)
        }
        const name = config.name || hyphenate(this.ctx.name)
        return this(name)[type](...args)
      }
    }
  }
}

export default Logger
