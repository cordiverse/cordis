import { Context } from '@cordisjs/core'
import Logger from 'reggol'

export { Logger }

declare module '@cordisjs/core' {
  interface Context {
    baseDir: string
    logger: LoggerService
  }
}

interface LoggerService {
  (name: string): Logger
}

export function apply(ctx: Context) {
  ctx.root.baseDir = globalThis.process?.cwd() || ''

  ctx.provide('logger', undefined, true)

  ctx.logger = function (name: string) {
    return new Logger(name, { [Context.current]: this })
  }

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
