import { Context, Service } from '@cordisjs/core'
import Logger from 'reggol'

export { Logger }

declare module '@cordisjs/core' {
  interface Context {
    logger: LoggerService
  }
}

export interface LoggerService extends Pick<Logger, Logger.Type | 'extend'> {
  (name: string): Logger
}

export class LoggerService extends Service {
  static [Service.provide] = 'logger'

  constructor(ctx: Context) {
    super(ctx, 'logger', true)

    ctx.on('internal/info', function (format, ...args) {
      this.logger('app').info(format, ...args)
    })

    ctx.on('internal/error', function (format, ...args) {
      this.logger('app').error(format, ...args)
    })

    ctx.on('internal/warning', function (format, ...args) {
      this.logger('app').warn(format, ...args)
    })
  }

  [Service.invoke](name: string) {
    return new Logger(name, { [Context.origin]: this })
  }

  static {
    for (const type of ['success', 'error', 'info', 'warn', 'debug', 'extend'] as const) {
      LoggerService.prototype[type] = function (this: any, ...args: any[]) {
        const caller: Context = this[Context.origin]
        return this(caller.name)[type](...args)
      }
    }
  }
}

export default LoggerService
