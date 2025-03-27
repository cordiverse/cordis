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

export async function start(options: Options) {
  const ctx = new Context()
  if (options.logger) await ctx.plugin(Logger, options.logger)
  if (options.daemon) await ctx.plugin(daemon, options.daemon)
  await ctx.plugin(Loader, options)
}
