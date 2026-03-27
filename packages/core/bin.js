#!/usr/bin/env node

import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

const ctx = new Context()
await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@cordisjs/plugin-include',
  config: {
    url: './cordis.yml',
  },
})
