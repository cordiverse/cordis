import { Entry } from '@cordisjs/loader'
import { Context } from './index.js'

export const inject = ['loader']

export function apply(ctx: Context, config: Entry[]) {
  for (const entry of config) {
    ctx.loader.reload(ctx, entry)
  }
}
