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

const internalLoaders: ((require: NodeRequire) => any)[] = [
  // Node 20.13 and above
  (require) => require('internal/modules/esm/loader').getOrInitializeCascadedLoader(),
  (require) => require('internal/process/esm_loader').esmLoader,
]

function getInternal() {
  const require = createRequire(import.meta.url)
  for (const loader of internalLoaders) {
    try {
      return loader(require)
    } catch {}
  }
}

export async function start(options: Options) {
  const ctx = new Context()
  ctx.plugin(Loader, {
    ...options,
    filename: process.env.CORDIS_LOADER_ENTRY,
  })
  if (process.execArgv.includes('--expose-internals')) {
    ctx.loader.internal = getInternal()
  }
  if (options.logger) ctx.plugin(logger, options.logger)
  if (options.daemon) ctx.plugin(daemon, options.daemon)
  await ctx.start()
}
