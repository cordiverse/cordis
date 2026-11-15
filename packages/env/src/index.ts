import { Context } from 'cordis'
import { parse } from 'dotenv'
import { expand } from 'dotenv-expand'
import { FsError } from '@cordisjs/fs'
import z from 'schemastery'

declare module 'cordis' {
  interface Context {
    env: Readonly<Record<string, string | undefined>>
  }
}

export const name = 'env'
export const inject = ['fs']

export interface Config {
  populate?: boolean
}

export const Config: z<Config> = z.object({
  populate: z.boolean().default(false).description('Also assign the variables of the env files to `process.env` while the component is active.'),
})

export async function apply(ctx: Context, config: Config = {}) {
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

  // a variable of the process environment takes precedence over the files
  const env: Record<string, string | undefined> = { ...process.env }
  expand({ parsed: merged, processEnv: env as Record<string, string> })

  if (config.populate) {
    ctx.effect(() => {
      // the values that the assignment replaces
      const previous = new Map<string, string | undefined>()
      for (const key of Object.keys(merged)) {
        if (process.env[key] === env[key]) continue
        previous.set(key, process.env[key])
        process.env[key] = env[key]
      }
      // A variable is restored only if it still has the assigned value, so
      // that a later change by others is kept.
      return () => {
        for (const [key, value] of previous) {
          if (process.env[key] !== env[key]) continue
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }
    }, 'env.populate')
  }

  // frozen, so that the values compared at the restoration are the assigned ones
  ctx.provide('env', Object.freeze(env))
}
