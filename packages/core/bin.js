#!/usr/bin/env node

import { Context } from 'cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@cordisjs/loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.use(Loader)
await ctx.loader.create({
  name: '@cordisjs/include',
  config: {
    path: './cordis.yml',
  },
})
