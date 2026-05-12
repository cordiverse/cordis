import { defineProperty, hyphenate } from 'cosmokit'
import { Context } from './context'
import { Fiber } from './fiber'
import { createCallable, joinPrototype, symbols, Tracker } from './utils'

declare module './context' {
  interface Intercept {
    logger: LoggerService.Intercept
  }
}

export type LoggerType = 'success' | 'error' | 'info' | 'warn' | 'debug'

export type LoggerMethod = (format: any, ...param: any[]) => void

export type Formatter = (value: any, exporter: Exporter, logger: Logger) => any

export const enum LoggerLevel {
  SILENT = 0,
  SUCCESS = 1,
  ERROR = 1,
  INFO = 2,
  WARN = 2,
  DEBUG = 3,
}

export interface Message {
  sn: number
  ts: number
  name: string
  type: LoggerType
  level: number
  body: string
  fiber?: WeakRef<Fiber>
}

export interface Exporter {
  colors?: number | false
  maxLength?: number
  levels?: Record<string, number>
  export(message: Message): void
}

export interface LoggerOptions {
  name: string
  meta?: Partial<Message>
  level?: number
}

export interface Logger extends LoggerOptions {}
export interface Logger extends Record<LoggerType, LoggerMethod> {}

function isAggregateError(error: any): error is Error & { errors: Error[] } {
  return error instanceof Error && Array.isArray(error['errors'])
}

export class Logger {
  static color(exporter: Exporter, code: number, value: any, decoration = '') {
    if (!exporter.colors) return '' + value
    return `\u001b[3${code < 8 ? code : '8;5;' + code}${exporter.colors >= 2 ? decoration : ''}m${value}\u001b[0m`
  }

  static code(name: string, level?: false | number) {
    let hash = 0
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 3) - hash) + name.charCodeAt(i) + 13
      hash |= 0
    }
    const colors = !level ? [] : level >= 2 ? c256 : c16
    return colors[Math.abs(hash) % colors.length]
  }

  constructor(options: LoggerOptions, private factory: LoggerFactory) {
    Object.assign(this, options)
    this.success = this._method('success', LoggerLevel.SUCCESS)
    this.error = this._method('error', LoggerLevel.ERROR)
    this.info = this._method('info', LoggerLevel.INFO)
    this.warn = this._method('warn', LoggerLevel.WARN)
    this.debug = this._method('debug', LoggerLevel.DEBUG)
  }

  private _method(type: LoggerType, level: number): LoggerMethod {
    return (...args: any[]) => {
      if (args.length === 1 && args[0] instanceof Error) {
        if (args[0].cause) {
          this[type](args[0].cause)
        } else if (isAggregateError(args[0])) {
          args[0].errors.forEach(error => this[type](error))
          return
        }
      }

      const sn = ++this.factory._snMessage
      const ts = Date.now()
      for (const exporter of this.factory.exporters.values()) {
        const targetLevel = exporter.levels?.[this.name] ?? exporter.levels?.default ?? this.level ?? LoggerLevel.INFO
        if (targetLevel < level) continue
        const body = this._format(exporter, args.slice())
        const message: Message = { sn, ts, type, level, name: this.name, ...this.meta, body }
        exporter.export(message)
      }
    }
  }

  private _format(exporter: Exporter, args: any[]) {
    if (args[0] instanceof Error) {
      args[0] = args[0].stack || args[0].message
      args.unshift('%s')
    } else if (typeof args[0] !== 'string') {
      args.unshift('%o')
    }

    let format: string = args.shift()
    format = format.replace(/%([a-zA-Z%])/g, (match, char) => {
      if (match === '%%') return '%'
      const formatter = this.factory.formatters[char]
      if (typeof formatter === 'function') {
        const value = args.shift()
        return formatter(value, exporter, this)
      }
      return match
    })

    for (let arg of args) {
      if (typeof arg === 'object' && arg) {
        arg = this.factory.formatters['o'](arg, exporter, this)
      }
      format += ' ' + arg
    }

    const { maxLength = 10240 } = exporter
    return format.split(/\r?\n/g).map(line => {
      return line.slice(0, maxLength) + (line.length > maxLength ? '...' : '')
    }).join('\n')
  }
}

export class LoggerFactory {
  static formatters: Record<string, Formatter> = {
    s: (value) => value,
    j: (value) => JSON.stringify(value),
    o: (value) => JSON.stringify(value),
    c: (value, exporter, logger) => {
      return Logger.color(exporter, Logger.code(logger.name, exporter.colors), value)
    },
  }

  _snMessage = 0
  _snExporter = 0

  exporters = new Map<number, Exporter>()
  formatters: Record<string, Formatter> = Object.create(LoggerFactory.formatters)

  createLogger(name: string, options: Omit<LoggerOptions, 'name'> = {}): Logger {
    return new Logger({ name, ...options }, this)
  }

  addExporter(exporter: Exporter) {
    this.exporters.set(++this._snExporter, exporter)
    return () => this.exporters.delete(this._snExporter)
  }
}

export const c16 = [6, 2, 3, 4, 5, 1]
export const c256 = [
  20, 21, 26, 27, 32, 33, 38, 39, 40, 41, 42, 43, 44, 45, 56, 57, 62,
  63, 68, 69, 74, 75, 76, 77, 78, 79, 80, 81, 92, 93, 98, 99, 112, 113,
  129, 134, 135, 148, 149, 160, 161, 162, 163, 164, 165, 166, 167, 168,
  169, 170, 171, 172, 173, 178, 179, 184, 185, 196, 197, 198, 199, 200,
  201, 202, 203, 204, 205, 206, 207, 208, 209, 214, 215, 220, 221,
]

export namespace LoggerService {
  export interface Intercept {
    name?: string
    level?: number
  }
}

export interface LoggerService extends Record<LoggerType, LoggerMethod> {
  (name?: string): Logger
}

export class LoggerService {
  factory = new LoggerFactory()
  bufferSize = 1000
  buffer: Message[] = []
  ctx!: Context

  constructor(ctx: Context) {
    const tracker: Tracker = {
      property: 'ctx',
      noShadow: true,
    }
    const self = createCallable('logger', joinPrototype(Object.getPrototypeOf(this), Function.prototype), tracker) as unknown as LoggerService
    Object.assign(self, this)
    self.ctx = ctx
    defineProperty(self, symbols.tracker, tracker)

    self.factory.addExporter({
      colors: 3,
      export: (message) => {
        self.buffer.push(message)
        if (self.buffer.length > self.bufferSize) {
          self.buffer = self.buffer.slice(-self.bufferSize)
        }
      },
    })

    return self
  }

  exporter(exporter: Exporter) {
    return this.ctx.effect(() => this.factory.addExporter(exporter), 'ctx.logger.exporter()')
  }

  private _resolveConfig(): LoggerService.Intercept {
    let intercept = this.ctx[symbols.intercept]
    const configs: LoggerService.Intercept[] = []
    while ('logger' in intercept) {
      if (Object.hasOwn(intercept, 'logger')) {
        configs.unshift(intercept['logger'])
      }
      intercept = Object.getPrototypeOf(intercept)
    }
    return Object.assign({}, ...configs)
  }

  [symbols.invoke](name?: string): Logger {
    const config = this._resolveConfig()
    name ??= config.name
    name ??= hyphenate(this.ctx.fiber.name)
    return this.factory.createLogger(name, {
      level: config.level,
      meta: { fiber: new WeakRef(this.ctx.fiber) },
    })
  }

  static {
    for (const type of ['success', 'error', 'info', 'warn', 'debug'] as const) {
      ;(LoggerService.prototype as any)[type] = function (this: LoggerService, ...args: any[]) {
        return (this as any)()[type](...args)
      }
    }
  }
}
