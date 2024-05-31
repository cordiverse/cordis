import { Logger } from '@cordisjs/logger'
import { Context } from '../index.ts'

declare module '@cordisjs/loader' {
  interface Loader {
    prolog: Logger.Record[]
  }
}

interface LogLevelConfig {
  base?: number
  [K: string]: LogLevel | undefined
}

type LogLevel = number | LogLevelConfig

export interface Config {
  levels?: LogLevel
  showDiff?: boolean
  showTime?: string | boolean
}

export const inject = ['loader']

export function apply(ctx: Context, config: Config = {}) {
  function handleException(error: any) {
    new Logger('app').error(error)
    process.exit(1)
  }

  process.on('uncaughtException', handleException)

  process.on('unhandledRejection', (error) => {
    new Logger('app').warn(error)
  })

  ctx.on('loader/entry-fork', (entry, type) => {
    if (entry.options.group) return
    ctx.logger('loader').info('%s plugin %c', type, entry.options.name)
  })

  ctx.loader.prolog = []

  Logger.targets.push({
    colors: 3,
    record: (record) => {
      ctx.loader.prolog.push(record)
      ctx.loader.prolog = ctx.loader.prolog.slice(-1000)
    },
  })

  const { levels } = config
  // configurate logger levels
  if (typeof levels === 'object') {
    Logger.levels = levels as any
  } else if (typeof levels === 'number') {
    Logger.levels.base = levels
  }

  let showTime = config.showTime
  if (showTime === true) showTime = 'yyyy-MM-dd hh:mm:ss'
  if (showTime) Logger.targets[0].showTime = showTime
  Logger.targets[0].showDiff = config.showDiff

  // cli options have higher precedence
  if (process.env.CORDIS_LOG_LEVEL) {
    Logger.levels.base = +process.env.CORDIS_LOG_LEVEL
  }

  function ensureBaseLevel(config: Logger.LevelConfig, base: number) {
    config.base ??= base
    Object.values(config).forEach((value) => {
      if (typeof value !== 'object') return
      ensureBaseLevel(value, config.base)
    })
  }

  ensureBaseLevel(Logger.levels, 2)

  if (process.env.CORDIS_LOG_DEBUG) {
    for (const name of process.env.CORDIS_LOG_DEBUG.split(',')) {
      new Logger(name).level = Logger.DEBUG
    }
  }

  Logger.targets[0].timestamp = Date.now()
}
