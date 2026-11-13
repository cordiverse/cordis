import { Context, Fiber } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Fs, { BaseFs, FsError, FsProvider, Watcher } from '../src/index.ts'

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

    it('mounts a subclass of `BaseFs` at `config.mount`', async () => {
      const ctx = await setup()
      const { calls, watch } = fakeProvider()
      class Provider extends BaseFs {
        watch = watch
      }
      await ctx.use(Provider, { mount: 'file:///' })
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

    it('rejects a reference that cannot be parsed with `InvalidPath`', async () => {
      const ctx = await setup('file:///app/cordis.yml')
      expect(() => ctx.fs.resolve('http://[')).to.throw(FsError).with.property('code', 'InvalidPath')
    })

        it('watches the resolved location', async () => {
      const ctx = await setup('mem://bucket/dir/config.yml')
      const provider = fakeProvider()
      ctx.fs.mount('mem:', provider)
      ctx.fs.watch('a.txt')
      expect(provider.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/dir/a.txt'])
    })
  })

  describe('operations', () => {
    function recorder() {
      const calls: [string, ...any[]][] = []
      const provider: FsProvider = {
        read(url) { calls.push(['read', url.href]); return new Blob(['foo']).stream() },
        async write(url, body) { calls.push(['write', url.href, await new Response(body).text()]) },
        async access(url, mode) { calls.push(['access', url.href, mode]) },
        async rename(src, dest) { calls.push(['rename', src.href, dest.href]) },
        async remove(url) { calls.push(['remove', url.href]) },
      }
      return { calls, provider }
    }

    async function code(promise: Promise<unknown>) {
      const error = await promise.then(() => undefined, error => error)
      expect(error).to.be.instanceOf(FsError)
      return error.code
    }

    it('forwards each operation to the provider of its location', async () => {
      const ctx = await setup('mem://bucket/dir/')
      const { calls, provider } = recorder()
      ctx.fs.mount('mem:', provider)

      const file = ctx.fs.file('a.txt')
      expect(file.url.href).to.equal('mem://bucket/dir/a.txt')
      expect(await file.text()).to.equal('foo')
      await file.write('bar')
      await ctx.fs.access('a.txt', 'write')
      await ctx.fs.rename('a.txt', 'b.txt')
      await ctx.fs.remove('b.txt')
      expect(calls).to.deep.equal([
        ['read', 'mem://bucket/dir/a.txt'],
        ['write', 'mem://bucket/dir/a.txt', 'bar'],
        ['access', 'mem://bucket/dir/a.txt', 'write'],
        ['rename', 'mem://bucket/dir/a.txt', 'mem://bucket/dir/b.txt'],
        ['remove', 'mem://bucket/dir/b.txt'],
      ])
    })

    it('routes a file reference when an operation is performed', async () => {
      const ctx = await setup()
      const file = ctx.fs.file('mem://bucket/a.txt')
      expect(await code(file.text())).to.equal('NoProvider')

      const { calls, provider } = recorder()
      ctx.fs.mount('mem:', provider)
      await file.text()
      expect(calls).to.deep.equal([['read', 'mem://bucket/a.txt']])
    })

    it('rejects with `NotSupported` for an operation the provider does not implement', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {})
      expect(await code(ctx.fs.file('mem://a.txt').text())).to.equal('NotSupported')
      expect(await code(ctx.fs.file('mem://a.txt').write(''))).to.equal('NotSupported')
      expect(await code(ctx.fs.access('mem://a.txt', 'write'))).to.equal('NotSupported')
      expect(await code(ctx.fs.rename('mem://a.txt', 'mem://b.txt'))).to.equal('NotSupported')
      expect(await code(ctx.fs.remove('mem://a.txt'))).to.equal('NotSupported')
    })

    it('rejects a rename between two mounts with `CrossesDevices`', async () => {
      const ctx = await setup()
      const outer = recorder()
      const inner = recorder()
      ctx.fs.mount('mem:', outer.provider)
      ctx.fs.mount('mem://bucket/', inner.provider)
      expect(await code(ctx.fs.rename('mem://other/a.txt', 'mem://bucket/a.txt'))).to.equal('CrossesDevices')
      expect([...outer.calls, ...inner.calls]).to.deep.equal([])
    })

    it('ignores only a missing location in a forced removal', async () => {
      const ctx = await setup()
      let failure: FsError.Code = 'NotFound'
      ctx.fs.mount('mem:', {
        async remove(url) { throw new FsError(failure, url, failure) },
      })
      expect(await code(ctx.fs.remove('mem://a.txt'))).to.equal('NotFound')
      await ctx.fs.remove('mem://a.txt', { force: true })
      failure = 'PermissionDenied'
      expect(await code(ctx.fs.remove('mem://a.txt', { force: true }))).to.equal('PermissionDenied')
    })
  })

  describe('file', () => {
    // a provider that serves `content` in chunks of `size` bytes, and stores what is written
    function memory(content: Uint8Array, size: number) {
      const written: Uint8Array[] = []
      const provider: FsProvider = {
        read() {
          let offset = 0
          return new ReadableStream({
            pull(controller) {
              if (offset >= content.byteLength) return controller.close()
              controller.enqueue(content.slice(offset, offset += size))
            },
          })
        },
        async write(url, body) {
          written.push(new Uint8Array(await new Response(body).arrayBuffer()))
        },
      }
      return { written, provider }
    }

    it('reads the content of a stream in several forms', async () => {
      const ctx = await setup()
      const json = '{"name":"cordis","emoji":"🌸"}'
      const content = new TextEncoder().encode(json)
      // chunks of 3 bytes split the 4 bytes of the emoji
      ctx.fs.mount('mem:', memory(content, 3).provider)
      const file = ctx.fs.file('mem://a.json')

      expect(await file.text()).to.equal(json)
      expect(await file.json()).to.deep.equal({ name: 'cordis', emoji: '🌸' })
      expect(await file.bytes()).to.deep.equal(content)
      expect(new Uint8Array(await file.arrayBuffer())).to.deep.equal(content)
      expect(await new Response(file.stream()).text()).to.equal(json)
    })

    it('writes each kind of data as a stream', async () => {
      const ctx = await setup()
      const { written, provider } = memory(new Uint8Array(), 1)
      ctx.fs.mount('mem:', provider)
      const file = ctx.fs.file('mem://a.txt')
      const bytes = new TextEncoder().encode('花')

      await file.write('花')
      await file.write(bytes)
      await file.write(bytes.buffer)
      await file.write(new Blob([bytes]))
      await file.write(new Blob([bytes]).stream())
      expect(written).to.deep.equal(Array(5).fill(bytes))
    })

    it('rejects a read with the error of the stream', async () => {
      const ctx = await setup()
      const error = new FsError('NotFound', new URL('mem://a.txt'), 'missing')
      ctx.fs.mount('mem:', {
        read: () => new ReadableStream({ start(controller) { controller.error(error) } }),
      })
      expect(await ctx.fs.file('mem://a.txt').text().catch(error => error)).to.equal(error)
    })
  })

  it('recognizes an `FsError` from another copy of the package', () => {
    const error = Object.assign(new Error(), { [Symbol.for('cordis.fs.error')]: true })
    expect(error).to.be.instanceOf(FsError)
    expect(new Error()).not.to.be.instanceOf(FsError)
  })
})
