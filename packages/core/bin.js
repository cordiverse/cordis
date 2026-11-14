#!/usr/bin/env node

import { Context } from 'cordis'
import Fs from '@cordisjs/fs'
import NodeFs from '@cordisjs/fs-node'
import Loader from '@cordisjs/loader'

const ctx = new Context()

await ctx.use(Fs)
await ctx.use(NodeFs)
await ctx.use(Loader)
await ctx.loader.create({
  name: '@cordisjs/include',
  config: {
    path: './cordis.yml',
  },
})
