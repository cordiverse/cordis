import { Context } from 'cordis'
import assert from 'node:assert'
// @ts-ignore
import schema, { z } from '../src'

function withContext(callback: (ctx: Context) => Promise<void>) {
  return async () => {
    const ctx = new Context()
    await ctx.plugin(schema)
    await callback(ctx)
  }
}

describe('inject.schema.config', () => {
  it('basic support', withContext(async (ctx) => {
    await assert.rejects(async () => {
      await ctx.plugin({
        inject: {
          schema: {
            required: true,
            config: z.object({
              foo: z.string().required(),
            }),
          },
        },
        apply(config) {},
      })
    })
  }))
})
