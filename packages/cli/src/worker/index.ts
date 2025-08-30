// DO NOT change this import to `cordis` as it is related to HMR semantics
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Logger from '@cordisjs/plugin-logger'
import * as daemon from './daemon.ts'
import * as dotenv from 'dotenv'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Options extends Loader.Config {
  execArgv?: string[]
  logger?: Logger.Config
  daemon?: daemon.Config
}

export async function start(options: Options) {
  // load .env files
  const override = {}
  const envFiles = ['.env', '.env.local']
  for (const filename of envFiles) {
    try {
      const raw = await readFile(join(process.cwd(), filename), 'utf8')
      Object.assign(override, dotenv.parse(raw))
    } catch {}
  }
  for (const key in override) {
    process.env[key] = override[key]
  }

  const ctx = new Context()
  if (options.logger) await ctx.plugin(Logger, options.logger)
  if (options.daemon) await ctx.plugin(daemon, options.daemon)
  await ctx.plugin(Loader, options)
}
