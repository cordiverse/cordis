import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import { WebSocket } from 'ws'
import Server from '@cordisjs/server'
import * as Acl from '../src/index.ts'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

interface RequestResult {
  status: number
  body: string
}

async function request(port: number, path: string, hostHeader: string): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { host: hostHeader },
    }, (res) => {
      let body = ''
      res.on('data', (c) => body += c)
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function tryWs(port: number, path: string, hostHeader: string): Promise<'open' | 'denied'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { host: hostHeader },
    })
    ws.on('open', () => {
      ws.close()
      resolve('open')
    })
    ws.on('error', () => resolve('denied'))
    ws.on('unexpected-response', () => resolve('denied'))
  })
}

async function setup(config?: Acl.Config) {
  const ctx = new Context()
  await ctx.use(Server, { host: '127.0.0.1', port: 0 })
  if (config !== undefined) {
    await ctx.use(Acl, config)
  }
  return ctx
}

describe('@cordisjs/server-acl', () => {
  let ctx: Context

  afterEach(async () => {
    await ctx?.fiber.dispose()
    await sleep()
  })

  describe('component-level allowedHosts', () => {
    it('no component loaded: any host allowed', async () => {
      ctx = await setup()
      ctx.std.server.get('/ping', async (req, res) => { res.body = 'pong' })
      await sleep()

      const a = await request(ctx.std.server.port, '/ping', 'localhost')
      const b = await request(ctx.std.server.port, '/ping', 'public.example.com')
      expect(a.status).to.equal(200)
      expect(b.status).to.equal(200)
    })

    it('undefined / true: any host allowed', async () => {
      ctx = await setup({})
      ctx.std.server.get('/ping', async (req, res) => { res.body = 'pong' })
      await sleep()

      const a = await request(ctx.std.server.port, '/ping', 'localhost')
      const b = await request(ctx.std.server.port, '/ping', 'public.example.com')
      expect(a.status).to.equal(200)
      expect(b.status).to.equal(200)
    })

    it('false: loopback allowed, others denied', async () => {
      ctx = await setup({ allowedHosts: false })
      ctx.std.server.get('/ping', async (req, res) => { res.body = 'pong' })
      await sleep()

      const loopback = await request(ctx.std.server.port, '/ping', '127.0.0.1')
      const localhost = await request(ctx.std.server.port, '/ping', 'localhost:3000')
      const ipv6 = await request(ctx.std.server.port, '/ping', '[::1]')
      const remote = await request(ctx.std.server.port, '/ping', 'public.example.com')
      expect(loopback.status).to.equal(200)
      expect(localhost.status).to.equal(200)
      expect(ipv6.status).to.equal(200)
      expect(remote.status).to.equal(404)
    })

    it('string[]: allow listed + loopback', async () => {
      ctx = await setup({ allowedHosts: ['public.example.com'] })
      ctx.std.server.get('/ping', async (req, res) => { res.body = 'pong' })
      await sleep()

      const listed = await request(ctx.std.server.port, '/ping', 'public.example.com')
      const loopback = await request(ctx.std.server.port, '/ping', 'localhost')
      const other = await request(ctx.std.server.port, '/ping', 'other.example.com')
      expect(listed.status).to.equal(200)
      expect(loopback.status).to.equal(200)
      expect(other.status).to.equal(404)
    })

    it('subdomain wildcard .example.com', async () => {
      ctx = await setup({ allowedHosts: ['.example.com'] })
      ctx.std.server.get('/ping', async (req, res) => { res.body = 'pong' })
      await sleep()

      const root = await request(ctx.std.server.port, '/ping', 'example.com')
      const sub = await request(ctx.std.server.port, '/ping', 'api.example.com')
      const deep = await request(ctx.std.server.port, '/ping', 'a.b.example.com')
      const other = await request(ctx.std.server.port, '/ping', 'example.org')
      expect(root.status).to.equal(200)
      expect(sub.status).to.equal(200)
      expect(deep.status).to.equal(200)
      expect(other.status).to.equal(404)
    })

    it('host header with port is stripped before matching', async () => {
      ctx = await setup({ allowedHosts: ['api.example.com'] })
      ctx.std.server.get('/ping', async (req, res) => { res.body = 'pong' })
      await sleep()

      const withPort = await request(ctx.std.server.port, '/ping', 'api.example.com:8443')
      expect(withPort.status).to.equal(200)
    })
  })

  describe('route-level allowedHosts', () => {
    it('route true overrides component false', async () => {
      ctx = await setup({ allowedHosts: false })
      ctx.std.server.get('/local', async (req, res) => { res.body = 'local' })
      ctx.std.server.get('/public', async (req, res) => { res.body = 'public' }, { allowedHosts: true })
      await sleep()

      const localFromRemote = await request(ctx.std.server.port, '/local', 'foo.com')
      const publicFromRemote = await request(ctx.std.server.port, '/public', 'foo.com')
      expect(localFromRemote.status).to.equal(404)
      expect(publicFromRemote.status).to.equal(200)
    })

    it('route false overrides component true', async () => {
      ctx = await setup({})
      ctx.std.server.get('/open', async (req, res) => { res.body = 'open' })
      ctx.std.server.get('/admin', async (req, res) => { res.body = 'admin' }, { allowedHosts: false })
      await sleep()

      const openRemote = await request(ctx.std.server.port, '/open', 'foo.com')
      const adminRemote = await request(ctx.std.server.port, '/admin', 'foo.com')
      const adminLocal = await request(ctx.std.server.port, '/admin', 'localhost')
      expect(openRemote.status).to.equal(200)
      expect(adminRemote.status).to.equal(404)
      expect(adminLocal.status).to.equal(200)
    })

    it('route list adds to component behavior', async () => {
      ctx = await setup({ allowedHosts: false })
      ctx.std.server.get('/partner', async (req, res) => { res.body = 'partner' }, {
        allowedHosts: ['partner.com'],
      })
      await sleep()

      const partner = await request(ctx.std.server.port, '/partner', 'partner.com')
      const loopback = await request(ctx.std.server.port, '/partner', 'localhost')
      const other = await request(ctx.std.server.port, '/partner', 'evil.com')
      expect(partner.status).to.equal(200)
      expect(loopback.status).to.equal(200)
      expect(other.status).to.equal(404)
    })
  })

  describe('intercept route options', () => {
    it('intercept routes merge into route.options', async () => {
      ctx = await setup({ allowedHosts: false })
      const scoped = ctx.intercept('std:server', {
        routes: {
          'GET /scoped': { allowedHosts: true },
        },
      })
      scoped.std.server.get('/scoped', async (req, res) => { res.body = 'scoped' })
      await sleep()

      const remote = await request(ctx.std.server.port, '/scoped', 'foo.com')
      expect(remote.status).to.equal(200)
    })
  })

  describe('WebSocket', () => {
    it('component-level false denies remote WS, allows loopback', async () => {
      ctx = await setup({ allowedHosts: false })
      ctx.std.server.ws('/events', async (req, accept) => {
        await accept()
      })
      await sleep()

      const local = await tryWs(ctx.std.server.port, '/events', 'localhost')
      const remote = await tryWs(ctx.std.server.port, '/events', 'evil.com')
      expect(local).to.equal('open')
      expect(remote).to.equal('denied')
    })

    it('route-level allowedHosts for WS', async () => {
      ctx = await setup({ allowedHosts: false })
      ctx.std.server.ws('/public-ws', async (req, accept) => {
        await accept()
      }, { allowedHosts: true })
      await sleep()

      const remote = await tryWs(ctx.std.server.port, '/public-ws', 'foo.com')
      expect(remote).to.equal('open')
    })
  })

  describe('fallthrough', () => {
    it('vetoed route falls through to the next matching route', async () => {
      ctx = await setup({})
      ctx.std.server.get('/both', async (req, res) => { res.body = 'local' }, { allowedHosts: false })
      ctx.std.server.get('/both', async (req, res) => { res.body = 'public' })
      await sleep()

      const remote = await request(ctx.std.server.port, '/both', 'evil.com')
      const local = await request(ctx.std.server.port, '/both', 'localhost')
      expect(remote.status).to.equal(200)
      expect(remote.body).to.equal('public')
      expect(local.status).to.equal(200)
      expect(local.body).to.equal('local')
    })

    it('vetoed sole route yields 404, not 405 (no information leak)', async () => {
      ctx = await setup({ allowedHosts: false })
      ctx.std.server.get('/api', async (req, res) => { res.body = 'ok' })
      await sleep()

      const remote = await request(ctx.std.server.port, '/api', 'evil.com')
      expect(remote.status).to.equal(404)
    })

    it('vetoed WS route falls through to next matching WS route', async () => {
      ctx = await setup({})
      ctx.std.server.ws('/both', async (req, accept) => {
        const ws = await accept()
        ws.send('local')
      }, { allowedHosts: false })
      ctx.std.server.ws('/both', async (req, accept) => {
        const ws = await accept()
        ws.send('public')
      })
      await sleep()

      const remote = await tryWs(ctx.std.server.port, '/both', 'evil.com')
      expect(remote).to.equal('open')
    })
  })
})
