import { Context, Service } from '@cordisjs/core'
import { defineProperty } from 'cosmokit'
import Logger from 'reggol'

export { Logger }

declare module '@cordisjs/core' {
  interface Context {
    logger: LoggerService
  }
}

declare module 'reggol' {
  namespace Logger {
    interface Meta {
      ctx?: Context
    }
  }
}

export interface LoggerService extends Pick<Logger, Logger.Type | 'extend'> {
  (name: string): Logger
}

export class LoggerService extends Service {
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
    return new Logger(name, defineProperty({}, 'ctx', this.ctx))
  }

  static {
    for (const type of ['success', 'error', 'info', 'warn', 'debug', 'extend']) {
      LoggerService.prototype[type] = function (this: LoggerService, ...args: any[]) {
        return this(this.ctx.name)[type](...args)
      }
    }
  }
}

export default LoggerService
