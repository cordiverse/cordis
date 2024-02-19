import Loader from '@cordisjs/loader'
import * as daemon from './daemon.js'
import * as logger from './logger.js'
import { ModuleLoader } from './internal.js'
import { Context } from '../index.ts'

export type * from './internal.js'

declare module '@cordisjs/loader' {
  interface Loader {
    internal?: ModuleLoader
  }
}

export interface Options extends Loader.Options {
  logger?: logger.Config
  daemon?: daemon.Config
}

export async function start(options: Options) {
  const ctx = new Context()
  ctx.plugin(Loader, options)
  if (process.execArgv.includes('--expose-internals')) {
    const { internal } = await import('./internal.js')
    ctx.loader.internal = internal
  }
  await ctx.loader.init(process.env.CORDIS_LOADER_ENTRY)
  if (options.logger) ctx.plugin(logger, options.logger)
  if (options.daemon) ctx.plugin(daemon, options.daemon)
  await ctx.loader.readConfig()
  await ctx.start()
}
