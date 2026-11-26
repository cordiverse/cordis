import { Context } from 'cordis'
import http from 'node:http'
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
    it('should forward upstream response headers', async () => {
      upstream.std.server.get('/headers', async (req, res, next) => {
        return new Response('ok', {
          headers: { 'x-custom': 'value' },
        })
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/headers`)
      expect(res.headers.get('x-custom')).to.equal('value')
    })
  })

  describe('target', () => {
    // a proxy of its own, forwarding to `target`
    async function createProxy(target: string) {
      const scoped = new Context().intercept('logger', { level: 3 })
      await scoped.use(LoggerConsole)
      await scoped.use(Server, { host: '127.0.0.1', port: 0 })
      await scoped.use(HTTP)
      await scoped.use(Proxy, { target })
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

    it('forwards the path without decoding it', async () => {
      upstream.std.server.get('{/*path}', async (req, res) => {
        res.body = req.path
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/a%3Fb%23c+d`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('/a%3Fb%23c+d')
    })

    it.each(['/%2e%2e/secret', '/v1/%2E%2E/%2e%2e/secret'])('rejects %s out of a URL', async (path) => {
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
  })
})
