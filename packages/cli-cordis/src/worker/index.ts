import { Context } from 'cordis'
import { noop } from 'cosmokit'
import Fs from '@cordisjs/fs'
import NodeFs from '@cordisjs/fs-node'
import { EntryOptions, Loader } from '@cordisjs/loader'
import * as daemon from './daemon.ts'

export interface Config {
  baseUrl?: string
  execArgv?: string[]
  path: string
  daemon: daemon.Config
  prelude?: EntryOptions[]
}

export async function start(config: Config) {
  const ctx = new Context()

  // Output to stdio is best-effort. A write error, such as EPIPE after the
  // reader has gone, would otherwise become an uncaught exception, whose log
  // entry is written to the same stream and raises the next one.
  process.stdout.on('error', noop)
  process.stderr.on('error', noop)

  process.on('uncaughtException', (error) => {
    ctx.logger.error(error)
    process.exitCode = 1
  })

  process.on('unhandledRejection', (error) => {
    ctx.logger.warn(error)
  })

  ctx.baseUrl = config.baseUrl
  if (config.daemon.enabled) {
    await ctx.use(daemon, config.daemon)
  }
  await ctx.use(Fs)
  await ctx.use(NodeFs)
  await ctx.use(Loader)
  for (const options of config.prelude ?? []) {
    await ctx.loader.create(options)
  }
  await ctx.loader.create({
    name: '@cordisjs/include',
    config: {
      path: config.path,
      enableLogs: true,
    },
  })
}
