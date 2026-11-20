import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Http from '../src/index.ts'

function fakeUndici() {
  const dispatchers: any[] = []
  const undici = {
    fetch: async (_url: URL, init: any) => {
      dispatchers.push(init.dispatcher)
      return new Response('ok')
    },
    ProxyAgent: class {},
    WebSocket: class {},
  }
  return { undici: undici as any, dispatchers }
}

async function withContext(
  config: Http.Config,
  callback: (ctx: Context, dispatchers: any[]) => Promise<void>,
) {
  const original = Http.undici
  const { undici, dispatchers } = fakeUndici()
  Http.undici = undici
  const ctx = new Context()
  await ctx.use(Http, config)
  ctx.http.proxy(['fake'], () => ({ name: 'fake-proxy' } as any))
  try {
    await callback(ctx, dispatchers)
  } finally {
    await ctx.fiber.dispose()
    Http.undici = original
  }
}

describe('ctx.http noProxy', () => {
  it('bypasses the proxy for a matching host or subdomain', () => withContext({
    proxyAgent: 'fake://proxy',
    noProxy: ['target.test', '.example.com'],
  }, async (ctx, dispatchers) => {
    await ctx.http('http://target.test/')
    await ctx.http('http://sub.example.com/')
    await ctx.http('http://other.test/')
    expect(dispatchers[0]).toBeUndefined()
    expect(dispatchers[1]).toBeUndefined()
    expect(dispatchers[2]).toEqual({ name: 'fake-proxy' })
  }))

  it('accepts a comma separated string and a host:port pattern', () => withContext({
    proxyAgent: 'fake://proxy',
    noProxy: '.example.com, localhost:8080',
  }, async (ctx, dispatchers) => {
    await ctx.http('http://example.com/')
    await ctx.http('http://localhost:8080/')
    await ctx.http('http://localhost/')
    expect(dispatchers[0]).toBeUndefined()
    expect(dispatchers[1]).toBeUndefined()
    expect(dispatchers[2]).toEqual({ name: 'fake-proxy' })
  }))

  it('bypasses every host for *', () => withContext({
    proxyAgent: 'fake://proxy',
    noProxy: '*',
  }, async (ctx, dispatchers) => {
    await ctx.http('http://any.test/')
    expect(dispatchers[0]).toBeUndefined()
  }))
})
