import { Context, Fiber } from 'cordis'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Fs, { BaseFs, FsError, Watcher, WatchOptions } from '../src/index.ts'

class FakeWatcher extends Watcher {
  closed = false

  protected async _start() {}

  protected _stop() {
    this.closed = true
  }
}

function fakeProvider() {
  const calls: FakeWatcher[] = []
  return {
    calls,
    watch(ctx: Context, url: URL, options: WatchOptions) {
      const watcher = new FakeWatcher(ctx, url, options)
      calls.push(watcher)
      return watcher
    },
  }
}

describe('Fs', () => {
  const fibers: Fiber<Context>[] = []

  afterEach(async () => {
    for (const fiber of fibers.splice(0)) await fiber.dispose()
  })

  async function setup(baseUrl?: string) {
    const root = new Context()
    root.baseUrl = baseUrl
    fibers.push(await root.use(Fs))
    return root
  }

  describe('mount', () => {
    it('forwards a location to the provider of the longest prefix that contains it', async () => {
      const ctx = await setup()
      const outer = fakeProvider()
      const inner = fakeProvider()
      ctx.fs.mount('file:///', outer)
      ctx.fs.mount('file:///data/', inner)

      ctx.fs.watch('file:///data/a.txt')
      ctx.fs.watch('file:///data')
      ctx.fs.watch('file:///database/a.txt')
      expect(inner.calls.map(call => call.url.href)).to.deep.equal(['file:///data/a.txt', 'file:///data'])
      expect(outer.calls.map(call => call.url.href)).to.deep.equal(['file:///database/a.txt'])
    })

    it('forwards every location of a scheme to the provider mounted at it', async () => {
      const ctx = await setup()
      const provider = fakeProvider()
      ctx.fs.mount('mem:', provider)

      ctx.fs.watch('mem://bucket/a.txt')
      expect(provider.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/a.txt'])
    })

    it('rejects a second provider at the same prefix', async () => {
      const ctx = await setup()
      ctx.fs.mount('file:///data', fakeProvider())
      expect(() => ctx.fs.mount('file:///data/', fakeProvider())).to.throw(/already mounted/)
    })

    it('throws `NoProvider` for a location without a provider', async () => {
      const ctx = await setup()
      ctx.fs.mount('file:///data/', fakeProvider())
      const error = (() => {
        try {
          ctx.fs.watch('file:///other/a.txt')
        } catch (error) {
          return error
        }
      })()
      expect(error).to.be.instanceOf(FsError)
      expect(error).to.include({ code: 'NoProvider' })
    })

    it('throws `NotSupported` for an operation the provider does not implement', async () => {
      const ctx = await setup()
      ctx.fs.mount('file:///', {})
      expect(() => ctx.fs.watch('file:///a.txt')).to.throw(FsError).with.property('code', 'NotSupported')
    })

    it('ends a mount with the calling fiber, together with the watches of its provider', async () => {
      const ctx = await setup()
      const provider = fakeProvider()
      const errors: unknown[] = []
      const mount = await ctx.inject(['fs'], (ctx) => {
        ctx.fs.mount('file:///', provider)
      })
      const watcher = ctx.fs.watch('file:///a.txt')
      watcher.on('error', (error) => { errors.push(error) })

      await mount.dispose()
      expect(provider.calls.map(call => call.closed)).to.deep.equal([true])
      await vi.waitFor(() => expect(errors).to.have.length(1))
      expect(errors[0]).to.include({ code: 'NoProvider' })
      expect(() => ctx.fs.watch('file:///a.txt')).to.throw(FsError)
    })

    it('mounts a subclass of `BaseFs` at its default mount point or at `config.mount`', async () => {
      const ctx = await setup()
      const { calls, watch } = fakeProvider()
      class Provider extends BaseFs {
        static mount = 'file:///'
        watch = watch
      }
      await ctx.use(Provider)
      await ctx.use(Provider, { mount: 'mem:' })

      ctx.fs.watch('file:///a.txt')
      ctx.fs.watch('mem://a.txt')
      expect(calls.map(call => call.url.href)).to.deep.equal(['file:///a.txt', 'mem://a.txt'])
    })
  })

  describe('path', () => {
    async function resolved(input: string, baseUrl?: string) {
      const ctx = await setup(baseUrl)
      const provider = fakeProvider()
      ctx.fs.mount('file:', provider)
      ctx.fs.mount('mem:', provider)
      ctx.fs.watch(input)
      return provider.calls[0].url.href
    }

    it('resolves a relative path against the calling context', async () => {
      const base = pathToFileURL(resolve('/app/cordis.yml')).href
      expect(await resolved('data/a.txt', base)).to.equal(pathToFileURL(resolve('/app/data/a.txt')).href)
    })

    it('resolves a relative path against the working directory without a context directory', async () => {
      expect(await resolved('a.txt')).to.equal(pathToFileURL(resolve('a.txt')).href)
    })

    it('resolves an absolute local path independently of the context directory', async () => {
      const path = resolve('/app/a.txt')
      const base = pathToFileURL(resolve('/other/cordis.yml')).href
      expect(await resolved(path, base)).to.equal(pathToFileURL(path).href)
    })

    it('forwards a path with empty segments to the provider mounted at its normalized location', async () => {
      const ctx = await setup()
      const outer = fakeProvider()
      const inner = fakeProvider()
      ctx.fs.mount('file:', outer)
      ctx.fs.mount(pathToFileURL(resolve('/app/data')), inner)
      ctx.fs.watch(resolve('/app') + '//data/a.txt')
      expect(inner.calls.map(call => call.url.href)).to.deep.equal([pathToFileURL(resolve('/app/data/a.txt')).href])
    })

    it.each([
      ['mem://user:pass@bucket/dir/config.yml', 'mem://user:pass@bucket'],
      ['mem:/dir/config.yml', 'mem:'],
    ])('resolves relative and rooted paths within the non-file base %s', async (base, prefix) => {
      expect(await resolved('a.txt', base)).to.equal(`${prefix}/dir/a.txt`)
      expect(await resolved('/a.txt', base)).to.equal(`${prefix}/a.txt`)
    })

    it('keeps URL syntax and backslashes literal in non-file paths', async () => {
      expect(await resolved(' a\\b#%?.txt\n', 'mem:/dir/config.yml'))
        .to.equal('mem:/dir/%20a%5Cb%23%25%3F.txt%0A')
    })

    it.runIf(process.platform !== 'win32')('takes a relative POSIX path with a drive-letter shape as a path', async () => {
      expect(await resolved('C:foo')).to.equal(pathToFileURL(resolve('C:foo')).href)
    })
  })
})
