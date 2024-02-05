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
  const loader = new Loader(ctx, options)
  if (process.execArgv.includes('--expose-internals')) {
    const { internal } = await import('./internal.js')
    loader.internal = internal
  }
  await loader.init(process.env.CORDIS_LOADER_ENTRY)
  if (options.logger) ctx.plugin(logger, options.logger)
  if (options.daemon) ctx.plugin(daemon, options.daemon)
  await loader.readConfig()
  await loader.start()
}
