#!/usr/bin/env node

import { Context } from 'cordis'
import { pathToFileURL } from 'node:url'
import Fs from '@cordisjs/plugin-fs-node'
import Loader from '@cordisjs/plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Fs)
await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: {
    path: './cordis.yml',
  },
})
