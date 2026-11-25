import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Http from '../src/index.ts'

describe('noProxy', () => {
  const proxy = {} as any
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.use(Http, { proxyAgent: 'fake://proxy' })
    ctx.std.http.proxy(['fake'], () => proxy)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  async function isProxied(url: string, noProxy: string[]) {
    let dispatcher: unknown
    const dispose = ctx.on('http/fetch', async (url, init) => {
      dispatcher = init.dispatcher
      return new Response()
    })
    await ctx.std.http(url, { noProxy })
    dispose()
    return dispatcher === proxy
  }

  it('matches a host and its subdomains', async () => {
    for (const entry of ['example.com', '.example.com', '*.example.com']) {
      expect(await isProxied('http://example.com/', [entry])).to.be.false
      expect(await isProxied('http://sub.example.com/', [entry])).to.be.false
      expect(await isProxied('http://notexample.com/', [entry])).to.be.true
    }
    expect(await isProxied('http://EXAMPLE.com/', ['example.COM'])).to.be.false
    expect(await isProxied('http://example.com./', ['example.com'])).to.be.false
    expect(await isProxied('http://example.com/', ['example.com.'])).to.be.false
  })

  it('ignores an entry that is not a host with an optional port', async () => {
    for (const entry of ['example.com:443/', 'example.com/path', 'example.com\\path', 'user@example.com', 'example.com?', 'exam\nple.com', 'example.com:']) {
      expect(await isProxied('https://example.com:8443/', [entry])).to.be.true
    }
    expect(await isProxied('https://example.com/', ['example.com:443/', 'example.com'])).to.be.false
  })

  it('matches a port, including the default port of the protocol', async () => {
    expect(await isProxied('http://localhost:8080/', ['localhost:8080'])).to.be.false
    expect(await isProxied('http://localhost/', ['localhost:8080'])).to.be.true
    expect(await isProxied('http://localhost/', ['localhost:80'])).to.be.false
    expect(await isProxied('https://localhost/', ['localhost:443'])).to.be.false
    expect(await isProxied('https://localhost/', ['localhost:80'])).to.be.true
  })

  it('matches an IPv6 address with or without brackets', async () => {
    expect(await isProxied('http://[::1]:8080/', ['::1'])).to.be.false
    expect(await isProxied('http://[::1]:8080/', ['[0:0::1]'])).to.be.false
    expect(await isProxied('http://[::1]:8080/', ['[::1]:8080'])).to.be.false
    expect(await isProxied('http://[::1]:8080/', ['[::1]:80'])).to.be.true
  })

  it('matches every host with *', async () => {
    expect(await isProxied('http://example.com/', ['*'])).to.be.false
  })

  it('applies to WebSocket connections', async () => {
    const dispatchers: unknown[] = []
    ctx.on('http/websocket', (url, init) => {
      dispatchers.push(init.dispatcher)
      return Object.assign(new EventTarget(), { close() {} }) as any
    })
    ctx.std.http.ws('http://example.com/', { noProxy: ['example.com'] })
    ctx.std.http.ws('http://other.com/', { noProxy: ['example.com'] })
    expect(dispatchers).to.deep.equal([undefined, proxy])
  })
})
