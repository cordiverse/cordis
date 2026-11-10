import { Context } from 'cordis'
import { parse } from 'dotenv'
import { expand } from 'dotenv-expand'
import { readFileSync } from 'node:fs'

declare module 'cordis' {
  interface Context {
    env: NodeJS.ProcessEnv
  }
}

export default function env(ctx: Context) {
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

  const merged: Record<string, string> = {}
  for (const file of files) {
    try {
      Object.assign(merged, parse(readFileSync(new URL(file, ctx.baseUrl))))
    } catch {}
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
