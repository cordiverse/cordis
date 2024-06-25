import { createRequire } from 'node:module'
import Loader from '@cordisjs/loader'
import * as daemon from './daemon.js'
import * as logger from './logger.js'
import { Context } from '../index.ts'

declare module '@cordisjs/loader' {
  interface Loader {
    internal?: ModuleLoader
  }
}

export interface Options extends Loader.Config {
  logger?: logger.Config
  daemon?: daemon.Config
}

export async function start(options: Options) {
  const ctx = new Context()
  ctx.plugin(Loader, {
    ...options,
    filename: process.env.CORDIS_LOADER_ENTRY,
  })
  if (process.execArgv.includes('--expose-internals')) {
    const require = createRequire(import.meta.url)
    ctx.loader.internal = require('internal/modules/esm/loader').getOrInitializeCascadedLoader()
  }
  if (options.logger) ctx.plugin(logger, options.logger)
  if (options.daemon) ctx.plugin(daemon, options.daemon)
  await ctx.start()
}
