import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import Server from '../src/index.ts'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function setup(config: Partial<Server.Config> = {}) {
  const ctx = new Context()
  await ctx.use(Server, {
    host: '127.0.0.1',
    port: 0,
    ...config,
  })
  return { ctx, url: ctx.server.baseUrl }
}

describe('@cordisjs/server', () => {
  let ctx: Context
  let url: string

  afterEach(async () => {
    await ctx?.fiber.dispose()
    await sleep()
  })

  describe('basic server lifecycle', () => {
    it('should start and listen', async () => {
      ({ ctx, url } = await setup())
      const res = await fetch(`${url}/`)
      expect(res.status).to.equal(404)
    })

    it('should fallback to next port if configured port is in use', async () => {
      ({ ctx, url } = await setup({ port: 30010, maxPort: 30020 }))
      const port1 = ctx.server.port

      const ctx2 = new Context()
      await ctx2.use(Server, { host: '127.0.0.1', port: 30010, maxPort: 30020 })
      expect(ctx2.server.port).to.equal(port1 + 1)
      await ctx2.fiber.dispose()
      await sleep()
    })
  })

  describe('HTTP routing', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should handle GET route', async () => {
      ctx.server.get('/hello', async (req, res, next) => {
        res.body = 'world'
      })
      await sleep()

      const res = await fetch(`${url}/hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('world')
    })

    it('should handle POST route', async () => {
      ctx.server.post('/echo', async (req, res, next) => {
        const text = await req.text()
        res.body = text
      })
      await sleep()

      const res = await fetch(`${url}/echo`, {
        method: 'POST',
        body: 'hello',
      })
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello')
    })

    it('should handle route returning Response object', async () => {
      ctx.server.get('/response', async (req, res, next) => {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })
      await sleep()

      const res = await fetch(`${url}/response`)
      expect(res.status).to.equal(200)
      expect(await res.json()).to.deep.equal({ ok: true })
    })

    it('should extract typed path params', async () => {
      ctx.server.get('/users/:id', async (req, res, next) => {
        res.body = req.params.id
      })
      await sleep()

      const res = await fetch(`${url}/users/42`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('42')
    })

    it('should decode path params', async () => {
      ctx.server.get('/files/:name', async (req, res, next) => {
        res.body = req.params.name
      })
      await sleep()

      const res = await fetch(`${url}/files/hello%20world`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello world')
    })

    it('should handle wildcard path params', async () => {
      ctx.server.get('{/*path}', async (req, res, next) => {
        res.body = req.params.path ?? null
      })
      await sleep()

      const res = await fetch(`${url}/a/b/c`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('a/b/c')
    })

    it('should match route with query string', async () => {
      ctx.server.get('/search', async (req, res, next) => {
        res.body = req.query.get('q') ?? ''
      })
      await sleep()

      const res = await fetch(`${url}/search?q=hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello')
    })

    it('should not leak query string into path params', async () => {
      ctx.server.get('{/*path}', async (req, res, next) => {
        res.body = req.params.path ?? null
      })
      await sleep()

      const res = await fetch(`${url}/a/b?foo=bar`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('a/b')
    })

    it('should handle regex routes', async () => {
      ctx.server.get(/^\/re\/(\d+)$/, async (req, res, next) => {
        res.body = req.params[1]
      })
      await sleep()

      const res = await fetch(`${url}/re/123`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('123')
    })

    it('should support all() to match any method', async () => {
      ctx.server.all('/any', async (req, res, next) => {
        res.body = req.method
      })
      await sleep()

      const get = await fetch(`${url}/any`)
      expect(await get.text()).to.equal('GET')

      const post = await fetch(`${url}/any`, { method: 'POST' })
      expect(await post.text()).to.equal('POST')
    })
  })

  describe('status codes', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should return 404 for unmatched path', async () => {
      const res = await fetch(`${url}/nonexistent`)
      expect(res.status).to.equal(404)
    })

    it('should return 405 with Allow header for mismatched method', async () => {
      ctx.server.get('/only-get', async (req, res, next) => {
        res.body = 'ok'
      })
      await sleep()

      const res = await fetch(`${url}/only-get`, { method: 'POST' })
      expect(res.status).to.equal(405)
      expect(res.headers.get('allow')).to.equal('get')
    })

    it('should treat all() as wildcard method in Allow header', async () => {
      ctx.server.all('/any', async (req, res, next) => {
        return next()
      })
      await sleep()

      const res = await fetch(`${url}/any`, { method: 'OPTIONS' })
      expect(res.status).to.equal(204)
      expect(res.headers.get('allow')).to.equal('*')
    })

    it('should handle OPTIONS with Allow header', async () => {
      ctx.server.get('/resource', async (req, res, next) => {
        res.body = 'ok'
      })
      ctx.server.post('/resource', async (req, res, next) => {
        res.body = 'ok'
      })
      await sleep()

      const res = await fetch(`${url}/resource`, { method: 'OPTIONS' })
      expect(res.status).to.equal(204)
      const allow = res.headers.get('allow')
      expect(allow).to.include('get')
      expect(allow).to.include('post')
    })

    it('should allow setting custom status code', async () => {
      ctx.server.get('/created', async (req, res, next) => {
        res.status = 201
        res.body = 'created'
      })
      await sleep()

      const res = await fetch(`${url}/created`)
      expect(res.status).to.equal(201)
    })

    it('should preserve status-only response (redirect)', async () => {
      ctx.server.get('/redirect', async (req, res, next) => {
        res.status = 302
        res.headers.set('location', '/new')
      })
      await sleep()

      const res = await fetch(`${url}/redirect`, { redirect: 'manual' })
      expect(res.status).to.equal(302)
      expect(res.headers.get('location')).to.equal('/new')
    })

    it('should preserve 204 empty response', async () => {
      ctx.server.get('/no-content', async (req, res, next) => {
        res.status = 204
      })
      await sleep()

      const res = await fetch(`${url}/no-content`)
      expect(res.status).to.equal(204)
    })

    it('should preserve custom 404 body', async () => {
      ctx.server.get('/nf', async (req, res, next) => {
        res.status = 404
        res.text('custom not found')
      })
      await sleep()

      const res = await fetch(`${url}/nf`)
      expect(res.status).to.equal(404)
      expect(await res.text()).to.equal('custom not found')
    })
  })

  describe('middleware (use)', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should run middleware before routes', async () => {
      const order: string[] = []
      ctx.server.use(async (req, res, next) => {
        order.push('middleware')
        await next()
      })
      ctx.server.get('/test', async (req, res, next) => {
        order.push('route')
        res.body = 'ok'
      })
      await sleep()

      await fetch(`${url}/test`)
      expect(order).to.deep.equal(['middleware', 'route'])
    })

    it('should allow middleware to short-circuit', async () => {
      ctx.server.use(async (req, res, next) => {
        res.status = 403
        res.body = 'forbidden'
      })
      ctx.server.get('/test', async (req, res, next) => {
        res.body = 'should not reach'
      })
      await sleep()

      const res = await fetch(`${url}/test`)
      expect(res.status).to.equal(403)
      expect(await res.text()).to.equal('forbidden')
    })

    it('should propagate a Response returned via next() so catch-alls can forward it', async () => {
      ctx.server.get('{/*path}', async (req, res, next) => {
        const response = await next()
        if (response || res.claimed) return response
        res.status = 200
        res.headers.set('content-type', 'text/html; charset=utf-8')
        res.body = '<fallback/>'
      })

      ctx.server.get('/api/thing', async () => {
        return Response.json({ ok: true })
      })

      await sleep()

      const res = await fetch(`${url}/api/thing`)
      expect(res.status).to.equal(200)
      expect(res.headers.get('content-type')).to.include('application/json')
      expect(await res.json()).to.deep.equal({ ok: true })
    })
  })

  describe('request body parsing', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should parse JSON body', async () => {
      ctx.server.post('/json', async (req, res, next) => {
        const data = await req.json()
        res.body = JSON.stringify(data)
        res.headers.set('content-type', 'application/json')
      })
      await sleep()

      const res = await fetch(`${url}/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      })
      expect(await res.json()).to.deep.equal({ foo: 'bar' })
    })

    it('should parse text body', async () => {
      ctx.server.post('/text', async (req, res, next) => {
        const text = await req.text()
        res.body = text.toUpperCase()
      })
      await sleep()

      const res = await fetch(`${url}/text`, {
        method: 'POST',
        body: 'hello',
      })
      expect(await res.text()).to.equal('HELLO')
    })
  })

  describe('request body validation', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    const stringSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate(value: unknown) {
          if (typeof value === 'string') return { value }
          return { issues: [{ message: 'expected string', path: [] }] }
        },
        types: { input: '' as string, output: '' as string },
      },
    }

    it('should pass validated body through', async () => {
      ctx.server.post('/v', async (req, res, next) => {
        const data = await req.json(stringSchema)
        res.body = data.toUpperCase()
      })
      await sleep()

      const res = await fetch(`${url}/v`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify('hello'),
      })
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('HELLO')
    })

    it('should respond 422 with issues on validation failure', async () => {
      ctx.server.post('/v', async (req, res, next) => {
        const data = await req.json(stringSchema)
        res.body = data
      })
      await sleep()

      const res = await fetch(`${url}/v`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ not: 'a string' }),
      })
      expect(res.status).to.equal(422)
      expect(res.headers.get('content-type')).to.match(/application\/json/)
      const body = await res.json()
      expect(body).to.have.property('issues')
      expect(body.issues).to.be.an('array')
      expect(body.issues[0]).to.have.property('message', 'expected string')
    })

    it('should support async validators', async () => {
      const asyncSchema = {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          async validate(value: unknown) {
            await sleep(1)
            if (typeof value === 'number') return { value }
            return { issues: [{ message: 'expected number' }] }
          },
          types: { input: 0 as number, output: 0 as number },
        },
      }
      ctx.server.post('/a', async (req, res, next) => {
        const n = await req.json(asyncSchema)
        res.body = String(n * 2)
      })
      await sleep()

      const ok = await fetch(`${url}/a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(21),
      })
      expect(ok.status).to.equal(200)
      expect(await ok.text()).to.equal('42')

      const bad = await fetch(`${url}/a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify('nope'),
      })
      expect(bad.status).to.equal(422)
    })
  })

  describe('response headers', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should set custom response headers', async () => {
      ctx.server.get('/headers', async (req, res, next) => {
        res.headers.set('x-custom', 'value')
        res.body = 'ok'
      })
      await sleep()

      const res = await fetch(`${url}/headers`)
      expect(res.headers.get('x-custom')).to.equal('value')
    })

    it('should auto-derive content-type from res.text()', async () => {
      ctx.server.get('/t', async (req, res, next) => { res.text('hi') })
      await sleep()

      const res = await fetch(`${url}/t`)
      expect(res.headers.get('content-type')).to.match(/^text\/plain/)
      expect(await res.text()).to.equal('hi')
    })

    it('should set content-type application/json for res.json()', async () => {
      ctx.server.get('/j', async (req, res, next) => { res.json({ a: 1 }) })
      await sleep()

      const res = await fetch(`${url}/j`)
      expect(res.headers.get('content-type')).to.match(/^application\/json/)
      expect(await res.json()).to.deep.equal({ a: 1 })
    })

    it('should preserve user content-type when set before body', async () => {
      ctx.server.get('/a', async (req, res, next) => {
        res.headers.set('content-type', 'text/html')
        res.text('<p>hi</p>')
      })
      await sleep()

      const res = await fetch(`${url}/a`)
      expect(res.headers.get('content-type')).to.equal('text/html')
      expect(await res.text()).to.equal('<p>hi</p>')
    })

    it('should preserve user content-type when set after body', async () => {
      ctx.server.get('/b', async (req, res, next) => {
        res.text('<p>hi</p>')
        res.headers.set('content-type', 'text/html')
      })
      await sleep()

      const res = await fetch(`${url}/b`)
      expect(res.headers.get('content-type')).to.equal('text/html')
      expect(await res.text()).to.equal('<p>hi</p>')
    })

    it('should overwrite body on subsequent writes', async () => {
      ctx.server.get('/overwrite', async (req, res, next) => {
        res.text('first')
        res.text('second')
      })
      await sleep()

      const res = await fetch(`${url}/overwrite`)
      expect(await res.text()).to.equal('second')
    })
  })

  describe('stream body concurrent reads', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    function makeStream(chunks: string[]) {
      return new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk))
          }
          controller.close()
        },
      })
    }

    it('should allow method read then flush via _end()', async () => {
      let inspected: string | undefined
      ctx.server.get('/stream', async (req, res, next) => {
        res.body = makeStream(['hello', ' ', 'world'])
        inspected = await res.text()
      })
      await sleep()

      const res = await fetch(`${url}/stream`)
      expect(await res.text()).to.equal('hello world')
      expect(inspected).to.equal('hello world')
    })

    it('should allow two concurrent method reads on the same stream body', async () => {
      let a: string | undefined
      let b: string | undefined
      ctx.server.get('/stream', async (req, res, next) => {
        res.body = makeStream(['foo', 'bar'])
        const [x, y] = await Promise.all([res.text(), res.text()])
        a = x
        b = y
        res.text('done')
      })
      await sleep()

      const res = await fetch(`${url}/stream`)
      expect(await res.text()).to.equal('done')
      expect(a).to.equal('foobar')
      expect(b).to.equal('foobar')
    })

    it('should allow body getter read then flush via _end()', async () => {
      ctx.server.get('/stream', async (req, res, next) => {
        res.body = makeStream(['abc', 'def'])
        const snapshot = res.body
        expect(snapshot).to.be.instanceOf(ReadableStream)
        const consumed = await new globalThis.Response(snapshot).text()
        expect(consumed).to.equal('abcdef')
      })
      await sleep()

      const res = await fetch(`${url}/stream`)
      expect(await res.text()).to.equal('abcdef')
    })
  })

  describe('route disposal', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should remove route on dispose', async () => {
      const route = ctx.server.get('/temp', async (req, res, next) => {
        res.body = 'exists'
      })
      await sleep()

      const res1 = await fetch(`${url}/temp`)
      expect(res1.status).to.equal(200)

      route.dispose()
      await sleep()

      const res2 = await fetch(`${url}/temp`)
      expect(res2.status).to.equal(404)
    })
  })

  describe('baseUrl', () => {
    it('should compute baseUrl from host and port', async () => {
      ({ ctx } = await setup())
      expect(ctx.server.baseUrl).to.match(/^http:\/\/127\.0\.0\.1:\d+$/)
    })

    it('should resolve wildcard host to 127.0.0.1', async () => {
      ({ ctx } = await setup({ host: '0.0.0.0' }))
      expect(ctx.server.baseUrl).to.match(/^http:\/\/127\.0\.0\.1:\d+$/)
    })

    it('should prefer config.baseUrl when set', async () => {
      ({ ctx } = await setup({ baseUrl: 'https://example.com/' }))
      expect(ctx.server.baseUrl).to.equal('https://example.com')
    })
  })

  describe('error handling', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should return 500 when route throws', async () => {
      ctx.server.get('/error', async (req, res, next) => {
        throw new Error('test error')
      })
      await sleep()

      const res = await fetch(`${url}/error`)
      expect(res.status).to.equal(500)
    })

    it('should not override status if already set before throw', async () => {
      ctx.server.get('/error', async (req, res, next) => {
        res.status = 503
        throw new Error('test error')
      })
      await sleep()

      const res = await fetch(`${url}/error`)
      expect(res.status).to.equal(503)
    })
  })

  describe('WebSocket routing', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    function connect(path: string) {
      const wsUrl = url.replace('http', 'ws') + path
      return new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        ws.on('open', () => resolve(ws))
        ws.on('error', reject)
      })
    }

    function connectRaw(path: string): Promise<{ statusCode: number }> {
      const wsUrl = url.replace('http', 'ws') + path
      return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl)
        ws.on('open', () => {
          ws.close()
          resolve({ statusCode: 101 })
        })
        ws.on('unexpected-response', (_req, res) => {
          resolve({ statusCode: res.statusCode! })
        })
        ws.on('error', () => {})
      })
    }

    it('should accept ws connection on matched route', async () => {
      ctx.server.ws('/ws')
      await sleep()

      const ws = await connect('/ws')
      expect(ws.readyState).to.equal(WebSocket.OPEN)
      ws.close()
    })

    it('should return 404 for unmatched ws route', async () => {
      const { statusCode } = await connectRaw('/no-such-ws')
      expect(statusCode).to.equal(404)
    })

    it('should track clients and clean up on close', async () => {
      const route = ctx.server.ws('/ws')
      await sleep()

      const ws = await connect('/ws')
      expect(route.clients.size).to.equal(1)

      const closed = new Promise<void>((resolve) => {
        for (const client of route.clients) {
          client.on('close', resolve)
        }
      })
      ws.close()
      await closed
      expect(route.clients.size).to.equal(0)
    })

    it('should close clients on route dispose', async () => {
      const route = ctx.server.ws('/ws')
      await sleep()

      const ws = await connect('/ws')
      const closed = new Promise<void>((resolve) => ws.on('close', resolve))

      route.dispose()
      await closed
      expect(ws.readyState).to.equal(WebSocket.CLOSED)
    })

    it('should support ws handler with accept', async () => {
      const messages: string[] = []
      ctx.server.ws('/ws', async (req, accept) => {
        const ws = await accept()
        ws.on('message', (data) => messages.push(data.toString()))
      })
      await sleep()

      const ws = await connect('/ws')
      ws.send('hello')
      await sleep(50)
      expect(messages).to.deep.equal(['hello'])
      ws.close()
    })

    it('should return 500 when ws handler throws', async () => {
      ctx.server.ws('/ws', async (req, accept) => {
        throw new Error('ws error')
      })
      await sleep()

      const { statusCode } = await connectRaw('/ws')
      expect(statusCode).to.equal(500)
    })

    it('should destroy socket when handler does not accept', async () => {
      ctx.server.ws('/ws', async (req, accept) => {
        // intentionally not calling accept
      })
      await sleep()

      const result = await new Promise<string>((resolve) => {
        const ws = new WebSocket(url.replace('http', 'ws') + '/ws')
        ws.on('error', (err) => resolve(err.message))
        ws.on('open', () => resolve('open'))
      })
      expect(result).to.not.equal('open')
    })
  })

  describe('intercept path prefix', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should scope route under intercept path', async () => {
      const scoped = ctx.intercept('server', { path: '/api' })
      scoped.server.get('/data', async (req, res, next) => {
        res.body = 'scoped'
      })
      await sleep()

      const res1 = await fetch(`${url}/api/data`)
      expect(res1.status).to.equal(200)
      expect(await res1.text()).to.equal('scoped')

      const res2 = await fetch(`${url}/data`)
      expect(res2.status).to.equal(404)
    })
  })

  describe('Route.Options and server/route-request', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should expose per-route options to server/route-request listeners', async () => {
      const seen: any[] = []
      ctx.on('server/route-request', async (req, res, route, next) => {
        seen.push((route.options as any).tag)
        return next()
      })
      ctx.server.get('/opts', async (req, res) => {
        res.body = 'ok'
      }, { tag: 'hello' } as any)
      await sleep()

      const res = await fetch(`${url}/opts`)
      expect(res.status).to.equal(200)
      expect(seen).to.deep.equal(['hello'])
    })

    it('should allow route-request listener to short-circuit before callback', async () => {
      let reached = false
      ctx.on('server/route-request', async (req, res, route, next) => {
        res.status = 401
        res.body = 'blocked'
        // do not call next
      })
      ctx.server.get('/guard', async () => {
        reached = true
        return Response.json({ ok: true })
      })
      await sleep()

      const res = await fetch(`${url}/guard`)
      expect(res.status).to.equal(401)
      expect(await res.text()).to.equal('blocked')
      expect(reached).to.equal(false)
    })

    it('intercept.routes should override per-route options on same key', async () => {
      const scoped = ctx.intercept('server', {
        routes: { 'GET /items': { tags: ['b', 'c'] } },
      } as any)
      let captured: any
      scoped.on('server/route-request', async (req, res, route, next) => {
        captured = route.options
        return next()
      })
      scoped.server.get('/items', async (req, res) => {
        res.body = 'ok'
      }, { tags: ['a', 'b'] } as any)
      await sleep()

      await fetch(`${url}/items`)
      expect(captured.tags).to.deep.equal(['b', 'c'])
    })

    it('intercept scalar should override per-route scalar', async () => {
      const scoped = ctx.intercept('server', {
        routes: { 'GET /scalar': { mode: 'strict' } },
      } as any)
      let captured: any
      scoped.on('server/route-request', async (req, res, route, next) => {
        captured = route.options
        return next()
      })
      scoped.server.get('/scalar', async (req, res) => {
        res.body = 'ok'
      }, { mode: 'lax' } as any)
      await sleep()

      await fetch(`${url}/scalar`)
      expect(captured.mode).to.equal('strict')
    })

    it('per-route keys absent from intercept are preserved', async () => {
      const scoped = ctx.intercept('server', {
        routes: { 'GET /mix': { b: 2 } },
      } as any)
      let captured: any
      scoped.on('server/route-request', async (req, res, route, next) => {
        captured = route.options
        return next()
      })
      scoped.server.get('/mix', async (req, res) => {
        res.body = 'ok'
      }, { a: 1 } as any)
      await sleep()

      await fetch(`${url}/mix`)
      expect(captured).to.deep.equal({ a: 1, b: 2 })
    })

    it('intercept key is method-specific', async () => {
      const scoped = ctx.intercept('server', {
        routes: { 'POST /same': { kind: 'post-only' } },
      } as any)
      const seen: any[] = []
      scoped.on('server/route-request', async (req, res, route, next) => {
        seen.push({ method: route.method, options: route.options })
        return next()
      })
      scoped.server.get('/same', async (req, res) => { res.body = 'g' })
      scoped.server.post('/same', async (req, res) => { res.body = 'p' })
      await sleep()

      await fetch(`${url}/same`)
      await fetch(`${url}/same`, { method: 'POST' })
      expect(seen).to.have.length(2)
      expect(seen[0]).to.deep.equal({ method: 'get', options: {} })
      expect(seen[1]).to.deep.equal({ method: 'post', options: { kind: 'post-only' } })
    })
  })
})
