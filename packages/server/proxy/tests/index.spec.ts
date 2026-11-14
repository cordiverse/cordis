import { Context } from 'cordis'
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
    upstreamUrl = upstream.server.baseUrl

    // proxy server
    proxy = new Context().intercept('logger', { level: 3 })
    await proxy.use(LoggerConsole)
    await proxy.use(Server, {
      host: '127.0.0.1',
      port: 0,
    })
    await proxy.use(HTTP)
    await proxy.use(Proxy, {
      baseUrl: upstreamUrl,
    })
    proxyUrl = proxy.server.baseUrl
  })

  afterEach(async () => {
    await proxy?.fiber.dispose()
    await upstream?.fiber.dispose()
    await sleep()
  })

  describe('GET requests', () => {
    it('should proxy a simple GET request', async () => {
      upstream.server.get('/hello', async (req, res, next) => {
        res.body = 'world'
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('world')
    })

    it('should proxy nested paths', async () => {
      upstream.server.get('/api/users/:id', async (req, res, next) => {
        res.body = req.params.id
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/api/users/42`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('42')
    })

    it('should forward query string', async () => {
      upstream.server.get('/search', async (req, res, next) => {
        res.body = req.query.get('q') ?? ''
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/search?q=hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello')
    })

    it('should proxy root path', async () => {
      upstream.server.get('/', async (req, res, next) => {
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
      upstream.server.post('/echo', async (req, res, next) => {
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
      upstream.server.post('/json', async (req, res, next) => {
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
      upstream.server.get('/not-found', async (req, res, next) => {
        return new Response(null, { status: 404, statusText: 'Not Found' })
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/not-found`)
      expect(res.status).to.equal(404)
    })
  })

  describe('response headers', () => {
    it('should forward upstream response headers', async () => {
      upstream.server.get('/headers', async (req, res, next) => {
        return new Response('ok', {
          headers: { 'x-custom': 'value' },
        })
      })
      await sleep()

      const res = await fetch(`${proxyUrl}/headers`)
      expect(res.headers.get('x-custom')).to.equal('value')
    })
  })

  describe('baseUrl with path prefix', () => {
    it('should correctly join with baseUrl path', async () => {
      upstream.server.get('/api/v1/data', async (req, res, next) => {
        res.body = 'scoped'
      })
      await sleep()

      // Create a new proxy with path prefix
      const scoped = new Context().intercept('logger', { level: 3 })
      await scoped.use(LoggerConsole)
      await scoped.use(Server, {
        host: '127.0.0.1',
        port: 0,
      })
      await scoped.use(HTTP)
      await scoped.use(Proxy, {
        baseUrl: upstreamUrl + '/api/v1/',
      })
      const scopedUrl = scoped.server.baseUrl

      const res = await fetch(`${scopedUrl}/data`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('scoped')

      await scoped.fiber.dispose()
      await sleep()
    })
  })
})
