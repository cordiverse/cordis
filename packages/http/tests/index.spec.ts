import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Http from '@cordisjs/http'

describe('http', () => {
  let ctx: Context

  beforeAll(async () => {
    ctx = new Context()
    await ctx.use(Http)
  })

  afterAll(async () => {
    await ctx.fiber.dispose()
  })

  it('fetches a data: URL through get()', async () => {
    expect(await ctx.http.get('data:text/plain,hello')).toBe('hello')
  })

  it('fetches a file: URL through get()', async () => {
    const url = new URL('../package.json', import.meta.url)
    expect(await ctx.http.get(url)).to.include({ name: '@cordisjs/http' })
  })
})
