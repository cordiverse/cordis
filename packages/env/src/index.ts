import { Context } from 'cordis'
import { parse } from 'dotenv'
import { expand } from 'dotenv-expand'
import { FsError } from '@cordisjs/fs'

declare module 'cordis' {
  interface Context {
    env: NodeJS.ProcessEnv
  }
}

export const name = 'env'
export const inject = ['fs']

export async function apply(ctx: Context) {
  const mode = process.env.NODE_ENV ?? 'development'

  // Load in priority order (low to high):
  // 1. .env
  // 2. .env.local
  // 3. .env.{mode}
  // 4. .env.{mode}.local
  const files = [
    './.env',
    './.env.local',
    `./.env.${mode}`,
    `./.env.${mode}.local`,
  ]

  // a missing file is skipped
  const contents = await Promise.all(files.map(async (file) => {
    try {
      return await ctx.fs.file(file).text()
    } catch (error) {
      if (error instanceof FsError && error.code === 'NotFound') return
      throw error
    }
  }))

  const merged: Record<string, string> = {}
  for (const content of contents) {
    if (content !== undefined) Object.assign(merged, parse(content))
  }

  // Expand variable references (e.g. ${VAR})
  expand({ parsed: merged, processEnv: process.env as Record<string, string> })

  // Apply to process.env (don't override existing values)
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }

  // Register process.env as ctx.env
  ctx.provide('env', process.env)
}
