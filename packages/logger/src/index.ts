import { Context, Service } from 'cordis'
import { defineProperty, hyphenate } from 'cosmokit'
import Logger from 'reggol'

export { Logger }

declare module 'cordis' {
  interface Context {
    logger: LoggerService
  }

  interface Intercept {
    logger: LoggerService.Config
  }
}

declare module 'reggol' {
  namespace Logger {
    interface Meta {
      ctx?: Context
    }
  }
}

export namespace LoggerService {
  export interface Config {
    name?: string
  }
}

export interface LoggerService extends Pick<Logger, Logger.Type | 'extend'> {
  (name: string): Logger
}

export class LoggerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'logger')

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
        let config: LoggerService.Config = {}
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

export default LoggerService
