#!/usr/bin/env node

import { Context, Logger } from 'cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@cordisjs/plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

// surface bootstrap errors that core buffers without a console exporter
const exporter = {
  colors: false,
  export(msg) {
    if (msg.type !== 'error') return
    process.exitCode = 1
    // `Logger.format` renders an error as its stack, so a cause core already
    // logged on its own is not repeated here
    console.error(Logger.format(exporter, msg))
  },
}
const dispose = ctx.logger.exporter(exporter)

await ctx.plugin(Loader)
try {
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: {
      path: './cordis.yml',
    },
  })
  await ctx.loader.await()
} catch {
  // the exporter above already reported this failure
} finally {
  dispose()
}
