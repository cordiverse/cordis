import { createRequire } from 'node:module'
// DO NOT change this import to `@cordisjs/core` as it is related to HMR semantics
import { Context } from 'cordis'
import Loader from '@cordisjs/loader'
import Logger from '@cordisjs/logger'
import * as daemon from './daemon.ts'

export interface Options extends Loader.Config {
  execArgv?: string[]
  logger?: Logger.Config
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
  if (options.logger) await ctx.plugin(Logger, options.logger)
  if (options.daemon) await ctx.plugin(daemon, options.daemon)
  await ctx.plugin(Loader, options)
  if (process.execArgv.includes('--expose-internals')) {
    ctx.loader.internal = getInternal()
  }
  await ctx.loader.start()
}
