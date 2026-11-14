import { Context, Fiber } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Fs, { BaseFs, FsError, Watcher } from '../src/index.ts'

interface FakeWatch {
  watcher: Watcher
  url: URL
  stopped: boolean
}

function fakeProvider() {
  const calls: FakeWatch[] = []
  return {
    calls,
    watch(watcher: Watcher) {
      const call: FakeWatch = { watcher, url: watcher.url, stopped: false }
      calls.push(call)
      return () => {
        call.stopped = true
      }
    },
  }
}

describe('Fs', () => {
  const fibers: Fiber[] = []

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

    it('stops the watches of a mount with the calling fiber, and keeps them', async () => {
      const ctx = await setup()
      const provider = fakeProvider()
      const errors: unknown[] = []
      const mount = await ctx.inject(['fs'], (ctx) => {
        ctx.fs.mount('file:///', provider)
      })
      const watcher = ctx.fs.watch('file:///a.txt')
      watcher.on('error', (error) => { errors.push(error) })

      await mount.dispose()
      expect(provider.calls.map(call => call.stopped)).to.deep.equal([true])
      expect(errors).to.deep.equal([])
      expect(() => ctx.fs.watch('file:///b.txt')).to.throw(FsError)
    })

    it('resumes a watch on a provider mounted again, without another `ready`', async () => {
      const ctx = await setup()
      const first = fakeProvider()
      const second = fakeProvider()
      const mount = await ctx.inject(['fs'], (ctx) => {
        ctx.fs.mount('mem:', first)
      })
      const watcher = ctx.fs.watch('mem://bucket/a.txt')
      const ready = vi.fn()
      const changes: string[] = []
      watcher.on('ready', ready)
      watcher.on('change', (url) => { changes.push(url.href) })
      first.calls[0].watcher.emit('ready')
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1))

      await mount.dispose()
      ctx.fs.mount('mem:', second)
      expect(second.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/a.txt'])
      second.calls[0].watcher.emit('ready')
      second.calls[0].watcher.emit('change', new URL('mem://bucket/a.txt'))
      await vi.waitFor(() => expect(changes).to.deep.equal(['mem://bucket/a.txt']))
      expect(ready).toHaveBeenCalledTimes(1)
    })

    it('moves a watch to the provider of a longer prefix mounted later, and back when it ends', async () => {
      const ctx = await setup()
      const outer = fakeProvider()
      const inner = fakeProvider()
      ctx.fs.mount('file:///', outer)
      ctx.fs.watch('file:///data/a.txt')
      const mount = await ctx.inject(['fs'], (ctx) => {
        ctx.fs.mount('file:///data/', inner)
      })
      expect(outer.calls.map(call => call.stopped)).to.deep.equal([true])
      expect(inner.calls.map(call => call.url.href)).to.deep.equal(['file:///data/a.txt'])

      await mount.dispose()
      expect(inner.calls.map(call => call.stopped)).to.deep.equal([true])
      expect(outer.calls.map(call => call.stopped)).to.deep.equal([true, false])
    })

    it('reports an error of a provider that takes over a watch', async () => {
      const ctx = await setup()
      const mount = await ctx.inject(['fs'], (ctx) => {
        ctx.fs.mount('mem:', fakeProvider())
      })
      const watcher = ctx.fs.watch('mem://a.txt')
      const errors: unknown[] = []
      watcher.on('error', (error) => { errors.push(error) })
      await mount.dispose()

      ctx.fs.mount('mem:', {})
      expect(errors).to.have.length(1)
      expect(errors[0]).to.include({ code: 'NotSupported' })
    })

    it('stops the watch of the provider when the calling fiber ends', async () => {
      const ctx = await setup()
      const provider = fakeProvider()
      ctx.fs.mount('mem:', provider)
      const fiber = await ctx.inject(['fs'], (ctx) => {
        ctx.fs.watch('mem://a.txt')
      })
      await fiber.dispose()
      expect(provider.calls.map(call => call.stopped)).to.deep.equal([true])

      ctx.fs.mount('mem://bucket/', fakeProvider())
      expect(provider.calls).to.have.length(1)
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

  describe('resolve', () => {
    it('resolves a relative reference against `ctx.baseUrl`', async () => {
      const ctx = await setup('file:///app/cordis.yml')
      expect(ctx.fs.resolve('data/a.txt').href).to.equal('file:///app/data/a.txt')
      expect(ctx.fs.resolve('/a.txt').href).to.equal('file:///a.txt')
    })

    it('takes an absolute URL independently of `ctx.baseUrl`', async () => {
      const ctx = await setup('file:///app/cordis.yml')
      expect(ctx.fs.resolve('mem://bucket/a.txt').href).to.equal('mem://bucket/a.txt')
      const url = new URL('mem://bucket/b.txt')
      expect(ctx.fs.resolve(url)).to.equal(url)
    })

    it('rejects a relative reference without `ctx.baseUrl`', async () => {
      const ctx = await setup()
      expect(() => ctx.fs.resolve('a.txt')).to.throw(TypeError)
      expect(ctx.fs.resolve('file:///a.txt').href).to.equal('file:///a.txt')
    })

    it('watches the resolved location', async () => {
      const ctx = await setup('mem://bucket/dir/config.yml')
      const provider = fakeProvider()
      ctx.fs.mount('mem:', provider)
      ctx.fs.watch('a.txt')
      expect(provider.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/dir/a.txt'])
    })
  })
})
