import Loader from '@cordisjs/loader'
import * as daemon from './daemon.js'
import * as logger from './logger.js'
import { ModuleLoader } from './internal.js'

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
  const loader = new Loader(options)
  if (process.execArgv.includes('--expose-internals')) {
    const { internal } = await import('./internal.js')
    loader.internal = internal
  }
  await loader.init(process.env.CORDIS_LOADER_ENTRY)
  if (options.logger) loader.app.plugin(logger)
  if (options.daemon) loader.app.plugin(daemon)
  await loader.readConfig()
  await loader.start()
}
