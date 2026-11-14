import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as http from 'node:http'
import Server from '@cordisjs/server'
import * as Static from '../src/index.ts'

function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function setup(config: Partial<Static.Config> = {}) {
  const ctx = new Context()
  await ctx.use(Server, {
    host: '127.0.0.1',
    port: 0,
  })
  await ctx.use(Static, {
    root: pathToFileURL(fixturesDir).href + '/',
    ...config,
  } as Static.Config)
  return { ctx, url: ctx.server.baseUrl }
}

describe('@cordisjs/server-static', () => {
  let ctx: Context
  let url: string

  afterEach(async () => {
    await ctx?.fiber.dispose()
    await sleep()
  })

  describe('serving files', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should serve an existing file', async () => {
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Hello</h1>\n')
    })

    it('should return 404 for missing file', async () => {
      const res = await fetch(`${url}/nonexistent.html`)
      expect(res.status).to.equal(404)
    })

    it('should serve file without extension', async () => {
      const res = await fetch(`${url}/noext`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('plain text\n')
    })
  })

  describe('extension fallback', () => {
    it('should not try extensions by default', async () => {
      ({ ctx, url } = await setup())
      const res = await fetch(`${url}/hello`)
      expect(res.status).to.equal(404)
    })

    it('should try .html extension when configured', async () => {
      ({ ctx, url } = await setup({ extensions: ['.html'] }))
      const res = await fetch(`${url}/hello`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Hello</h1>\n')
    })

    it('should prefer exact file over extension fallback', async () => {
      ({ ctx, url } = await setup({ extensions: ['.html'] }))
      const res = await fetch(`${url}/page`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Page without extension</h1>\n')
    })
  })

  describe('index files', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should serve index file for root', async () => {
      const res = await fetch(`${url}/`, { redirect: 'manual' })
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Index</h1>\n')
    })

    it('should serve index file for subdirectory with trailing slash', async () => {
      const res = await fetch(`${url}/sub/`, { redirect: 'manual' })
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('<h1>Sub Index</h1>\n')
    })
  })

  describe('directory redirect', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should redirect directory without trailing slash', async () => {
      const res = await fetch(`${url}/sub`, { redirect: 'manual' })
      expect(res.status).to.equal(301)
      expect(res.headers.get('location')).to.include('/sub/')
    })

    it('should not redirect when redirect is disabled', async () => {
      ({ ctx, url } = await setup({ redirect: false }))
      const res = await fetch(`${url}/sub`, { redirect: 'manual' })
      expect(res.status).to.not.equal(301)
    })
  })

  describe('path traversal protection', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup())
    })

    it('should return 403 for path traversal', async () => {
      // fetch() normalizes URLs, so we use raw http.get to preserve ..
      const port = ctx.server.port
      const res = await new Promise<http.IncomingMessage>((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/..%2F..%2F..%2Fetc/passwd' }, resolve)
      })
      expect(res.statusCode).to.equal(403)
    })
  })

  describe('fallthrough', () => {
    it('should not fallthrough by default', async () => {
      ({ ctx, url } = await setup())
      const res = await fetch(`${url}/missing`)
      expect(res.status).to.equal(404)
    })

    it('should fallthrough when enabled', async () => {
      ({ ctx, url } = await setup({ fallthrough: true }))
      ctx.server.get('{/*path}', async (req, res, next) => {
        res.body = 'fallback'
      })
      await sleep()

      const res = await fetch(`${url}/missing`)
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('fallback')
    })
  })

  describe('error pages', () => {
    beforeEach(async () => {
      ({ ctx, url } = await setup({ errorPages: { 404: 'errors/404.html' } }))
    })

    it('should serve custom error page with original status', async () => {
      const res = await fetch(`${url}/nonexistent`)
      expect(res.status).to.equal(404)
      expect(await res.text()).to.equal('<h1>Not Found</h1>\n')
    })
  })

  describe('exclude', () => {
    it('should block files matching exclude pattern', async () => {
      ({ ctx, url } = await setup({ exclude: ['**/.*'] }))
      const res = await fetch(`${url}/.secret`)
      expect(res.status).to.equal(404)
    })

    it('should serve files not matching exclude pattern', async () => {
      ({ ctx, url } = await setup({ exclude: ['**/.*'] }))
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
    })

    it('should support multiple exclude patterns', async () => {
      ({ ctx, url } = await setup({ exclude: ['*.html', 'noext'] }))
      const res1 = await fetch(`${url}/hello.html`)
      expect(res1.status).to.equal(404)
      const res2 = await fetch(`${url}/noext`)
      expect(res2.status).to.equal(404)
    })
  })

  describe('download mode', () => {
    it('should set content-disposition when download is true', async () => {
      ({ ctx, url } = await setup({ download: true }))
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
      const disposition = res.headers.get('content-disposition')
      expect(disposition).to.include('attachment')
    })

    it('should set inline content-disposition when download is false', async () => {
      ({ ctx, url } = await setup({ download: false }))
      const res = await fetch(`${url}/hello.html`)
      expect(res.status).to.equal(200)
      const disposition = res.headers.get('content-disposition')
      expect(disposition).to.include('inline')
    })
  })
})
