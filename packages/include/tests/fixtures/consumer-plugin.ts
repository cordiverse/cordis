import { Context } from 'cordis'

export const name = 'consumer-plugin'

/** What each apply saw, so a test can tell a stale inject from a fresh one. */
export const seen: any[] = []

export function apply(ctx: Context, config: any) {
  const record = {
    config,
    inject: { ...ctx.fiber!.inject },
    service: (ctx as any).service,
  }
  seen.push(record)
  ctx.on('test/inject', () => record)
}
