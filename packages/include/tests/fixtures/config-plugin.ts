import { Context } from 'cordis'

export const name = 'config-plugin'

/** Tags of every apply, in order, so tests can count restarts. */
export const applied: string[] = []

export function apply(ctx: Context, config: any) {
  applied.push(config.tag)
  ctx.on('test/config', (tag: string) => tag === config.tag ? config : undefined)
}
