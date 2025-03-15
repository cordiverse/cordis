import { Context, Service } from '@cordisjs/core'
import { hyphenate } from 'cosmokit'
import { Exporter, Factory, Logger, Message, Type } from 'reggol'

export * from 'reggol'

declare module '@cordisjs/core' {
  interface Context {
    logger: LoggerService
  }

  interface Intercept {
    logger: LoggerService.Intercept
  }
}

declare module 'reggol' {
  interface Message {
    ctx?: WeakRef<Context>
  }
}

namespace LoggerService {
  export interface Config {
    bufferSize?: number
  }

  export interface Intercept {
    name?: string
    level?: number
  }
}

interface LoggerService extends Pick<Logger, Type> {
  (name?: string): Logger
}

class LoggerService extends Service {
  factory = new Factory()
  buffer: Message[] = []

  constructor(ctx: Context, public config: LoggerService.Config = {}) {
    super(ctx, 'logger')

    const { bufferSize = 1000 } = config

    this.factory.addExporter(new Exporter.Console({
      timestamp: Date.now(),
    }))

    this.factory.addExporter({
      colors: 3,
      export: (message) => {
        this.buffer.push(message)
        this.buffer = this.buffer.slice(-bufferSize)
      },
    })

    const defaultLogger = this.factory.createLogger('app')

    ctx.on('internal/info', (format, ...args) => {
      defaultLogger.info(format, ...args)
    })

    ctx.on('internal/error', (format, ...args) => {
      defaultLogger.error(format, ...args)
    })

    ctx.on('internal/warning', (format, ...args) => {
      defaultLogger.warn(format, ...args)
    })

    process.on('uncaughtException', (error) => {
      defaultLogger.error(error)
      process.exitCode = 1
    })

    process.on('unhandledRejection', (error) => {
      defaultLogger.warn(error)
    })
  }

  exporter(exporter: Exporter) {
    return this.ctx.effect(() => this.factory.addExporter(exporter))
  }

  [Service.invoke](name?: string) {
    let config: LoggerService.Intercept = {}
    let intercept = this.ctx[Context.intercept]
    while (intercept) {
      config = Object.assign({}, intercept.logger, config)
      intercept = Object.getPrototypeOf(intercept)
    }
    name ??= hyphenate(this.ctx.name)
    return this.factory.createLogger(name, {
      level: config.level,
      meta: { ctx: new WeakRef(this.ctx) },
    })
  }

  static {
    for (const type of ['success', 'error', 'info', 'warn', 'debug']) {
      LoggerService.prototype[type] = function (this: LoggerService, ...args: any[]) {
        return this()[type](...args)
      }
    }
  }
}

export default LoggerService
