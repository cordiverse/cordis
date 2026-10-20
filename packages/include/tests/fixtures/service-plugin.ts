import { Context } from 'cordis'

export const name = 'service-plugin'

export function apply(ctx: Context, config: any) {
  ctx.provide('service', { ...config })
}
