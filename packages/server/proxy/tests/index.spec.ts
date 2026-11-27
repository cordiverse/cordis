import { Context } from 'cordis'
import http from 'node:http'
import { json } from 'node:stream/consumers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import HTTP from '@cordisjs/http'
import LoggerConsole from '@cordisjs/logger-console'
import Server from '@cordisjs/server'
import * as Proxy from '../src/index.ts'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe('@cordisjs/server-proxy', () => {
  let upstream: Context
  let proxy: Context
  let upstreamUrl: string
  let proxyUrl: string

  beforeEach(async () => {
    // upstream server
    upstream = new Context()
    await upstream.use(Server, {
      host: '127.0.0.1',
      port: 0,
    })
    upstreamUrl = upstream.std.server.publicUrl

    // proxy server
    proxy = new Context().intercept('logger', { level: 3 })
    await proxy.use(LoggerConsole)
    await proxy.use(Server, {
      host: '127.0.0.1',
      port: 0,
    })
    await proxy.use(HTTP)
    await proxy.use(Proxy, {
      target: upstreamUrl + '/',
    })
    proxyUrl = proxy.std.server.publicUrl
  })

  afterEach(async () => {
    await proxy?.fiber.dispose()
    await upstream?.fiber.dispose()
    await sleep()
  })

  describe('GET requests', () => {
    it('should proxy a simple GET request', async () => {
      upstream.std.server.get('/hello', async (req, res, next) => {
        res.body = 'world'
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('world')
    })

    it('should proxy nested paths', async () => {
      upstream.std.server.get('/api/users/:id', async (req, res, next) => {
        res.body = req.params.id
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/api/users/42`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('42')
    })

    it('should forward query string', async () => {
      upstream.std.server.get('/search', async (req, res, next) => {
        res.body = req.query.get('q') ?? ''
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/search?q=hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello')
    })

    it('should proxy root path', async () => {
      upstream.std.server.get('/', async (req, res, next) => {
        res.body = 'root'
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('root')
    })
  })

  describe('POST requests', () => {
    it('should forward request body', async () => {
      upstream.std.server.post('/echo', async (req, res, next) => {
        const text = await req.text()
        res.body = text
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/echo`, {
        method: 'POST',
        body: 'hello proxy',
      })
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello proxy')
    })

    it('should forward JSON body', async () => {
      upstream.std.server.post('/json', async (req, res, next) => {
        const data = await req.json()
        return new Response(JSON.stringify(data), {
          headers: { 'content-type': 'application/json' },
        })
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      })
      expect(res.status).to.equal(200)
      expect(await res.json()).to.deep.equal({ foo: 'bar' })
    })
  })

  describe('status codes', () => {
    it('should forward upstream status codes', async () => {
      upstream.std.server.get('/not-found', async (req, res, next) => {
        return new Response(null, { status: 404, statusText: 'Not Found' })
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/not-found`)
      expect(res.status).to.equal(404)
    })
  })

  describe('response headers', () => {
    it('forwards end-to-end response headers and consumes upstream connection options', async () => {
      upstream.std.server.get('/headers', async (req, res, next) => {
        return new Response('ok', {
          headers: {
            connection: 'keep-alive, X-Upstream-Only',
            'x-upstream-only': 'local',
            'proxy-authenticate': 'Basic realm="proxy"',
            'www-authenticate': 'Basic realm="upstream"',
          },
        })
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/headers`)
      expect(res.headers.get('x-upstream-only')).to.equal(null)
      expect(res.headers.get('proxy-authenticate')).to.equal(null)
      expect(res.headers.get('www-authenticate')).to.equal('Basic realm="upstream"')
    })
  })

  describe('target', () => {
    // a proxy of its own, forwarding to `target`
    async function createProxy(target: string, options: Omit<Proxy.Config, 'target'> = {}) {
      const scoped = new Context().intercept('logger', { level: 3 })
      await scoped.use(LoggerConsole)
      await scoped.use(Server, { host: '127.0.0.1', port: 0 })
      await scoped.use(HTTP)
      await scoped.use(Proxy, { target, ...options })
      return scoped
    }

    let scoped: Context | undefined

    afterEach(async () => {
      await scoped?.fiber.dispose()
      scoped = undefined
    })

    it.each([
      '',
      'http:',
      'HTTPS:',
      'https://example.com/',
      'https://example.com/api/v1/',
    ])('accepts %j', (target) => {
      expect(() => Proxy.Config({ target })).not.to.throw()
    })

    it.each([
      'https://example.com',
      'https://example.com/api/v1',
      'https://example.com/?key=value',
      'https://example.com/#fragment',
      'https:///',
      'file:',
      'file:///',
    ])('rejects %j', (target) => {
      expect(() => Proxy.Config({ target })).to.throw()
    })

    it('forwards to a URL followed by the path', async () => {
      upstream.std.server.get('{/*path}', async (req, res) => {
        res.body = req.url
      })
      await sleep()

      scoped = await createProxy(upstreamUrl + '/api/v1/')
      const res1 = await fetch(`${scoped.std.server.publicUrl}/users?key=value`)
      expect(res1.status).to.equal(200)
      expect(await res1.text()).to.equal('/api/v1/users?key=value')
      // a sibling of the target directory with the same prefix
      const res2 = await fetch(`${scoped.std.server.publicUrl}/v10/secret`)
      expect(res2.status).to.equal(200)
      expect(await res2.text()).to.equal('/api/v1/v10/secret')
    })

    it('forwards an encoded separator that stays under a URL', async () => {
      upstream.std.server.get('{/*path}', async (req, res) => {
        res.body = req.path
      })
      await sleep()

      scoped = await createProxy(upstreamUrl + '/api/v1/')
      const res = await fetch(`${scoped.std.server.publicUrl}/group%2Fproject/..%2Fother`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('/api/v1/group%2Fproject/..%2Fother')
    })

    it('forwards to a URL with an encoded separator', async () => {
      upstream.std.server.get('{/*path}', async (req, res) => {
        res.body = req.path
      })
      await sleep()

      scoped = await createProxy(upstreamUrl + '/group%2Fproject/')
      const res = await fetch(`${scoped.std.server.publicUrl}/items`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('/group%2Fproject/items')
    })

    it('rejects an encoded separator out of a URL with an encoded separator', async () => {
      let reached = false
      upstream.std.server.get('{/*path}', async (req, res) => {
        reached = true
        res.body = req.path
      })
      await sleep()

      scoped = await createProxy(upstreamUrl + '/group%2Fproject/')
      const res = await fetch(`${scoped.std.server.publicUrl}/..%2Fother`)
      expect(res.status).to.equal(400)
      expect(reached).to.equal(false)
    })

    it('forwards the path under the path prefix of the routes', async () => {
      upstream.std.server.get('{/*path}', async (req, res) => {
        res.body = req.url
      })
      await sleep()

      scoped = new Context().intercept('logger', { level: 3 })
      await scoped.use(Server, { host: '127.0.0.1', port: 0 })
      await scoped.use(HTTP)
      const mounted = scoped.intercept('std:server', { path: '/proxy' })
      await mounted.use(Proxy, { target: upstreamUrl + '/api/' })
      const res1 = await fetch(`${mounted.std.server.publicUrl}/users?key=value`)
      expect(await res1.text()).to.equal('/api/users?key=value')
      const res2 = await fetch(mounted.std.server.publicUrl)
      expect(await res2.text()).to.equal('/api/')
    })

    it('forwards the path without decoding it', async () => {
      upstream.std.server.get('{/*path}', async (req, res) => {
        res.body = req.path
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/a%3Fb%23c+d`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('/a%3Fb%23c+d')
    })

    it.each([
      '/%2E%2e/secret',
      '/..%2Fsecret',
      '/..%5csecret',
      // the parser removes `a%2Fb%2Fc` as one segment, before an upstream decodes the rest
      '/a%2Fb%2Fc/../..%2F..%2Fsecret',
    ])('rejects %s out of a URL', async (path) => {
      let reached = false
      upstream.std.server.get('{/*path}', async (req, res) => {
        reached = true
        res.body = req.path
      })
      await sleep()

      // fetch() removes dot segments, so the request is sent through `node:http`
      scoped = await createProxy(upstreamUrl + '/api/v1/')
      const status = await new Promise<number>((resolve, reject) => {
        http.get(scoped!.std.server.publicUrl + '/', { path }, (res) => {
          res.resume()
          resolve(res.statusCode!)
        }).on('error', reject)
      })
      expect(status).to.equal(400)
      expect(reached).to.equal(false)
    })

    it('forwards to a scheme followed by the path', async () => {
      upstream.std.server.get('/hello', async (req, res) => {
        res.body = req.query.get('key') ?? ''
      })
      await sleep()

      scoped = await createProxy('http:')
      const res = await fetch(`${scoped.std.server.publicUrl}/${upstreamUrl.slice(7)}/hello?key=value`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('value')
    })

    it('forwards to the URL in the path for the empty string', async () => {
      upstream.std.server.get('/hello', async (req, res) => {
        res.body = req.query.get('key') ?? ''
      })
      await sleep()

      scoped = await createProxy('')
      const res = await fetch(`${scoped.std.server.publicUrl}/${upstreamUrl}/hello?key=value`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('value')
    })

    it.each(['file:///etc/hosts', 'data:,secret', 'not-a-url'])('rejects %s for the empty string', async (url) => {
      scoped = await createProxy('')
      const res = await fetch(`${scoped.std.server.publicUrl}/${url}`)
      expect(res.status).to.equal(400)
    })

    it.each([
      ['an HTTP URL', (url: string) => url],
      ['a WebSocket URL', (url: string) => url.replace(/^http/, 'ws')],
    ])('forwards a WebSocket to %s in the path for the empty string', async (_, toUrl) => {
      upstream.std.server.ws('/echo', async (req, accept) => {
        const socket = await accept()
        socket.on('message', data => socket.send(data.toString()))
      })
      await sleep()

      scoped = await createProxy('')
      const base = scoped.std.server.publicUrl.replace(/^http/, 'ws')
      const socket = new WebSocket(`${base}/${toUrl(upstreamUrl)}/echo`)
      const message = await new Promise<string>((resolve, reject) => {
        socket.addEventListener('open', () => socket.send('hello'))
        socket.addEventListener('message', event => resolve(event.data))
        socket.addEventListener('error', () => reject(new Error('WebSocket error')))
      })
      socket.close()
      expect(message).to.equal('hello')
    })

    async function echoCookie(isolateOrigin?: boolean) {
      upstream.std.server.get('/hello', async (req) => {
        return new Response(req.headers.get('cookie') ?? '', {
          headers: [['set-cookie', 'a=1'], ['clear-site-data', '"cookies"']],
        })
      })
      await sleep()
      scoped = await createProxy(upstreamUrl + '/', { isolateOrigin })
      return fetch(`${scoped.std.server.publicUrl}/hello`, { headers: { cookie: 'session=1' } })
    }

    it('isolates the origin of the routes from the upstream', async () => {
      const res = await echoCookie(true)
      expect(await res.text()).to.equal('')
      expect(res.headers.get('set-cookie')).to.equal(null)
      expect(res.headers.get('clear-site-data')).to.equal(null)
      expect(res.headers.get('content-security-policy')).to.equal('sandbox')
      expect(res.headers.get('x-content-type-options')).to.equal('nosniff')
    })

    it('shares the origin of the routes with the upstream by default', async () => {
      const res = await echoCookie()
      expect(await res.text()).to.equal('session=1')
      expect(res.headers.get('set-cookie')).to.equal('a=1')
      expect(res.headers.get('clear-site-data')).to.equal('"cookies"')
      expect(res.headers.get('content-security-policy')).to.equal(null)
    })

    it('uses only the configured sources for upstream credentials', async () => {
      upstream.std.server.get('/headers', async (req, res) => {
        res.json(Object.fromEntries(req.headers))
      })
      scoped = await createProxy('', { isolateOrigin: true, requestHeaders: {
        Authorization: 'X-Upstream-Auth',
        cookie: 'x-upstream-cookie',
      } })
      const url = scoped.std.server.publicUrl + '/' + upstreamUrl + '/headers'
      const incoming = { authorization: 'site', cookie: 'site=1', 'x-other': 'ok' }
      const explicit = await fetch(url, { headers: {
        ...incoming, 'x-upstream-auth': 'api', 'X-Upstream-Cookie': 'api=1',
      } }).then(res => res.json())
      expect(explicit).to.include({ authorization: 'api', cookie: 'api=1', 'x-other': 'ok' })
      expect(explicit).not.to.have.property('x-upstream-auth')
      expect(explicit).not.to.have.property('x-upstream-cookie')
      const implicit = await fetch(url, { headers: incoming }).then(res => res.json())
      expect(implicit).not.to.have.property('authorization')
      expect(implicit).not.to.have.property('cookie')
    })

    it.each([
      ['Proxy-Authorization', 'X-Explicit', false, /proxy-authorization/i],
      ['X-Explicit', 'Proxy-Authorization', false, /proxy-authorization/i],
      ['X-Explicit', 'Cookie', true, /cookie/i],
    ] as const)('rejects the mapping of %s from %s at load time', async (name, source, isolateOrigin, error) => {
      const fiber = proxy.use(Proxy, { target: '', isolateOrigin, requestHeaders: { [name]: source } })
      await expect(fiber.await()).rejects.toThrow(error)
    })

    it('keeps proxy credentials and fields named by Connection on the incoming hop', async () => {
      upstream.std.server.get('/headers', async (req, res) => {
        res.json(Object.fromEntries(req.headers))
      })
      await sleep()

      // fetch() refuses to set `connection`, so the request is sent through `node:http`
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get(`${proxyUrl}/headers`, { headers: {
          authorization: 'api', 'proxy-authorization': 'proxy', connection: 'X-Local', 'x-local': 'local',
        } }, resolve).on('error', reject)
      })
      const headers = await json(response) as Record<string, string>
      expect(headers.authorization).to.equal('api')
      expect(headers).not.to.have.property('proxy-authorization')
      expect(headers).not.to.have.property('x-local')
    })

    it.each([
      ['by default', {}, 'site', 'site=1'],
      ['with isolateOrigin', { isolateOrigin: true }, 'site', undefined],
      ['through requestHeaders', { requestHeaders: { authorization: 'x-auth', cookie: 'x-cookie' } }, 'api', 'api=1'],
    ] as const)('forwards the credentials of a WebSocket %s', async (_, options, authorization, cookie) => {
      let received: Record<string, string>
      upstream.std.server.ws('/echo', async (req, accept) => {
        received = Object.fromEntries(req.headers)
        await accept()
      })
      await sleep()

      scoped = await createProxy(upstreamUrl + '/', options)
      const base = scoped.std.server.publicUrl.replace(/^http/, 'ws')
      const { WebSocket } = await import('undici')
      const socket = new WebSocket(`${base}/echo`, { headers: {
        authorization: 'site', cookie: 'site=1', 'proxy-authorization': 'proxy', 'x-auth': 'api', 'x-cookie': 'api=1',
      } })
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve())
        socket.addEventListener('error', () => reject(new Error('WebSocket error')))
      })
      socket.close()
      expect(received!.authorization).to.equal(authorization)
      expect(received!.cookie).to.equal(cookie)
      expect(received!).not.to.have.property('proxy-authorization')
    })
  })
})
