import { Context, Fiber, FiberState } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Fs, { BaseFs, CopyOptions, DirEntryRef, DirRef, EntryRef, FileRef, FsError, FsProvider, StatOptions, Stats, Watcher, WriteOptions } from '../src/index.ts'

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
    fibers.push(await root.use(Fs, { baseUrl }))
    return root
  }

  // starts the service as on a runtime without a working directory
  async function startWithoutCwd(config: Fs.Config = {}) {
    const root = new Context()
    vi.stubGlobal('process', undefined)
    try {
      const fiber = root.plugin(Fs, config)
      fibers.push(fiber)
      await fiber.await().catch(() => {})
      return { root, fiber }
    } finally {
      vi.unstubAllGlobals()
    }
  }

  describe('mount', () => {
    it('rejects a prefix that is not a location', async () => {
      const ctx = await setup()
      for (const prefix of ['mem://bucket/%2F', 'mem://bucket/a?x']) {
        expect(() => ctx.std.fs.mount(prefix, fakeProvider())).to.throw(FsError).with.property('code', 'InvalidPath')
      }
    })

    it('forwards a location to the provider of the longest prefix that contains it', async () => {
      const ctx = await setup()
      const outer = fakeProvider()
      const inner = fakeProvider()
      ctx.std.fs.mount('file:///', outer)
      ctx.std.fs.mount('file:///data/', inner)

      ctx.std.fs.watch('file:///data/a.txt')
      ctx.std.fs.watch('file:///data')
      ctx.std.fs.watch('file:///database/a.txt')
      expect(inner.calls.map(call => call.url.href)).to.deep.equal(['file:///data/a.txt', 'file:///data'])
      expect(outer.calls.map(call => call.url.href)).to.deep.equal(['file:///database/a.txt'])
    })

    it('forwards every location of a scheme to the provider mounted at it', async () => {
      const ctx = await setup()
      const provider = fakeProvider()
      ctx.std.fs.mount('mem:', provider)

      ctx.std.fs.watch('mem://bucket/a.txt')
      expect(provider.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/a.txt'])
    })

    it('forwards the locations of no other mount to the provider mounted at the empty string', async () => {
      const ctx = await setup()
      const fallback = fakeProvider()
      const provider = fakeProvider()
      ctx.std.fs.mount('', fallback)
      ctx.std.fs.mount('mem:', provider)

      ctx.std.fs.watch('mem://bucket/a.txt')
      ctx.std.fs.watch('file:///a.txt')
      ctx.std.fs.watch('https://example.com/a.txt')
      expect(provider.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/a.txt'])
      expect(fallback.calls.map(call => call.url.href)).to.deep.equal(['file:///a.txt', 'https://example.com/a.txt'])
    })

    it('rejects a second provider at the same prefix', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('file:///data', fakeProvider())
      expect(() => ctx.std.fs.mount('file:///data/', fakeProvider())).to.throw(/already mounted/)
    })

    it('throws `NoProvider` for a location without a provider', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('file:///data/', fakeProvider())
      const error = (() => {
        try {
          ctx.std.fs.watch('file:///other/a.txt')
        } catch (error) {
          return error
        }
      })()
      expect(error).to.be.instanceOf(FsError)
      expect(error).to.include({ code: 'NoProvider' })
    })

    it('throws `NotSupported` for an operation the provider does not implement', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('file:///', {})
      expect(() => ctx.std.fs.watch('file:///a.txt')).to.throw(FsError).with.property('code', 'NotSupported')
    })

    it('stops the watches of a mount with the calling fiber, and keeps them', async () => {
      const ctx = await setup()
      const provider = fakeProvider()
      const errors: unknown[] = []
      const mount = await ctx.inject(['std:fs'], (ctx) => {
        ctx.std.fs.mount('file:///', provider)
      })
      const watcher = ctx.std.fs.watch('file:///a.txt')
      watcher.on('error', (error) => { errors.push(error) })

      await mount.dispose()
      expect(provider.calls.map(call => call.stopped)).to.deep.equal([true])
      expect(errors).to.deep.equal([])
      expect(() => ctx.std.fs.watch('file:///b.txt')).to.throw(FsError)
    })

    it('resumes a watch on a provider mounted again, without another `ready`', async () => {
      const ctx = await setup()
      const first = fakeProvider()
      const second = fakeProvider()
      const mount = await ctx.inject(['std:fs'], (ctx) => {
        ctx.std.fs.mount('mem:', first)
      })
      const watcher = ctx.std.fs.watch('mem://bucket/a.txt')
      const ready = vi.fn()
      const changes: string[] = []
      watcher.on('ready', ready)
      watcher.on('change', (url) => { changes.push(url.href) })
      first.calls[0].watcher.emit('ready')
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1))

      await mount.dispose()
      ctx.std.fs.mount('mem:', second)
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
      ctx.std.fs.mount('file:///', outer)
      ctx.std.fs.watch('file:///data/a.txt')
      const mount = await ctx.inject(['std:fs'], (ctx) => {
        ctx.std.fs.mount('file:///data/', inner)
      })
      expect(outer.calls.map(call => call.stopped)).to.deep.equal([true])
      expect(inner.calls.map(call => call.url.href)).to.deep.equal(['file:///data/a.txt'])

      await mount.dispose()
      expect(inner.calls.map(call => call.stopped)).to.deep.equal([true])
      expect(outer.calls.map(call => call.stopped)).to.deep.equal([true, false])
    })

    it('reports an error of a provider that takes over a watch', async () => {
      const ctx = await setup()
      const mount = await ctx.inject(['std:fs'], (ctx) => {
        ctx.std.fs.mount('mem:', fakeProvider())
      })
      const watcher = ctx.std.fs.watch('mem://a.txt')
      const errors: unknown[] = []
      watcher.on('error', (error) => { errors.push(error) })
      await mount.dispose()

      ctx.std.fs.mount('mem:', {})
      expect(errors).to.have.length(1)
      expect(errors[0]).to.include({ code: 'NotSupported' })
    })

    it('stops the watch of the provider when the calling fiber ends', async () => {
      const ctx = await setup()
      const provider = fakeProvider()
      ctx.std.fs.mount('mem:', provider)
      const fiber = await ctx.inject(['std:fs'], (ctx) => {
        ctx.std.fs.watch('mem://a.txt')
      })
      await fiber.dispose()
      expect(provider.calls.map(call => call.stopped)).to.deep.equal([true])

      ctx.std.fs.mount('mem://bucket/', fakeProvider())
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

      ctx.std.fs.watch('file:///a.txt')
      ctx.std.fs.watch('mem://a.txt')
      expect(calls.map(call => call.url.href)).to.deep.equal(['file:///a.txt', 'mem://a.txt'])
    })
  })

  describe('resolve', () => {
    it('resolves a path against the base URL', async () => {
      const ctx = await setup('file:///app/')
      expect(ctx.std.fs.resolve('data/a.txt').href).to.equal('file:///app/data/a.txt')
      expect(ctx.std.fs.resolve('./data/../a.txt').href).to.equal('file:///app/a.txt')
      expect(ctx.std.fs.resolve('/a.txt').href).to.equal('file:///a.txt')
      expect(ctx.std.fs.resolve('data/').href).to.equal('file:///app/data/')
      expect(ctx.std.fs.resolve('').href).to.equal('file:///app/')
    })

    it('takes every character of a name in a path literally', async () => {
      const ctx = await setup('mem://bucket/')
      expect(ctx.std.fs.resolve('a#b?c%41 .txt').href).to.equal('mem://bucket/a%23b%3Fc%2541%20.txt')
      expect(ctx.std.fs.resolve(' a\tb\n').href).to.equal('mem://bucket/%20a%09b%0A')
      // a name that looks like a scheme follows `./`
      expect(ctx.std.fs.resolve('./ab:c').href).to.equal('mem://bucket/ab:c')
    })

    it('separates the names of a path with `\\`', async () => {
      const ctx = await setup('mem://bucket/')
      expect(ctx.std.fs.resolve('dir\\a.txt').href).to.equal('mem://bucket/dir/a.txt')
      expect(ctx.std.fs.resolve('\\a.txt').href).to.equal('mem://bucket/a.txt')
    })

    it('takes a drive letter as the first name of an absolute path, on the local host of a file URL', async () => {
      const ctx = await setup('file://nas/share/app/')
      expect(ctx.std.fs.resolve('D:\\data\\a.txt').href).to.equal('file:///D:/data/a.txt')
      expect(ctx.std.fs.resolve('D:/data/').href).to.equal('file:///D:/data/')
      expect(ctx.std.fs.resolve('/x').href).to.equal('file://nas/x')
      expect((await setup('C:\\app')).std.fs.baseUrl?.href).to.equal('file:///C:/app/')
    })

    it('takes two leading separators and a host as a path on that host', async () => {
      const ctx = await setup('file:///C:/app/')
      expect(ctx.std.fs.resolve('\\\\fileserver\\team\\a.txt').href).to.equal('file://fileserver/team/a.txt')
      expect(ctx.std.fs.resolve('//fileserver/team/').href).to.equal('file://fileserver/team/')
      const memory = await setup('mem://bucket/')
      expect(memory.std.fs.resolve('//other/a.txt').href).to.equal('mem://other/a.txt')
    })

    it('takes each element of an array as a literal name', async () => {
      const ctx = await setup('mem://bucket/')
      expect(ctx.std.fs.resolve(['dir', 'a\\b#1.txt']).href).to.equal('mem://bucket/dir/a%5Cb%231.txt')
      expect(ctx.std.fs.resolve(['a.txt'], new URL('mem://bucket/dir')).href).to.equal('mem://bucket/dir/a.txt')
      for (const names of [[''], ['.'], ['..'], ['a/b']]) {
        expect(() => ctx.std.fs.resolve(names)).to.throw(FsError).with.property('code', 'InvalidPath')
      }
    })

    // a file URL reads a first segment `C|` as the drive `C:`
    it('keeps the name `C|` in every segment', async () => {
      const ctx = await setup('mem://bucket/')
      expect(decodeURIComponent(ctx.std.fs.resolve(['C|'], new URL('file:///')).pathname)).to.equal('/C|')
      expect(ctx.std.fs.resolve('C|/a', new URL('file:///app/')).href).to.equal('file:///app/C|/a')
      expect(ctx.std.fs.resolve('../C|/a', new URL('file:///D:/')).href).to.equal('file:///D:/C|/a')
      expect(ctx.std.fs.resolve('C|/a', new URL('mem://bucket/app/')).href).to.equal('mem://bucket/app/C|/a')
    })

    it('rejects a URL that is not a location, and leaves an opaque URL to its provider', async () => {
      const ctx = await setup('mem://bucket/')
      for (const location of ['mem://bucket/a?x', 'mem://bucket/a#x', 'mem://bucket/a%2Fb', 'mem://bucket/100%.txt']) {
        expect(() => ctx.std.fs.file(location)).to.throw(FsError).with.property('code', 'InvalidPath')
        expect(() => ctx.std.fs.resolve(new URL(location))).to.throw(FsError).with.property('code', 'InvalidPath')
      }
      expect(ctx.std.fs.resolve('data:,a#b').href).to.equal('data:,a#b')
    })

    it('takes an absolute URL independently of the base URL', async () => {
      const ctx = await setup('file:///app/')
      expect(ctx.std.fs.resolve('mem://bucket/a.txt').href).to.equal('mem://bucket/a.txt')
      const url = new URL('mem://bucket/b.txt')
      expect(ctx.std.fs.resolve(url)).to.equal(url)
    })

    it('resolves a path against the working directory by default', async () => {
      const ctx = await setup()
      expect(ctx.std.fs.resolve('a.txt').href).to.equal(pathToFileURL(join(process.cwd(), 'a.txt')).href)
    })

    it('takes only absolute URLs as locations without a base URL', async () => {
      const { root } = await startWithoutCwd()
      expect(root.std.fs.baseUrl).to.be.undefined
      expect(root.std.fs.resolve('mem://bucket/a.txt').href).to.equal('mem://bucket/a.txt')
      for (const path of ['a.txt', ['a.txt']]) {
        expect(() => root.std.fs.resolve(path)).to.throw(FsError).with.property('code', 'InvalidPath')
      }
      expect(root.intercept('std:fs', { baseUrl: 'mem://bucket/' }).std.fs.resolve('a.txt').href).to.equal('mem://bucket/a.txt')
      expect(() => root.intercept('std:fs', { baseUrl: 'data/' }).std.fs.baseUrl).to.throw(TypeError)
    })

    it('fails to start with a path as the base URL on a runtime without a working directory', async () => {
      const { root } = await startWithoutCwd({ baseUrl: 'mem://bucket/' })
      expect(root.std.fs.resolve('a.txt').href).to.equal('mem://bucket/a.txt')
      const { fiber } = await startWithoutCwd({ baseUrl: 'data/' })
      expect(fiber.state).to.equal(FiberState.FAILED)
    })

    it('does not read the working directory for an absolute base URL', async () => {
      vi.spyOn(process, 'cwd').mockImplementation(() => {
        throw new Error('no working directory')
      })
      try {
        const ctx = await setup('mem://bucket/')
        expect(ctx.std.fs.baseUrl?.href).to.equal('mem://bucket/')
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('resolves a path of the config against the working directory', async () => {
      const ctx = await setup('data')
      expect(ctx.std.fs.baseUrl?.href).to.equal(pathToFileURL(join(process.cwd(), 'data')).href + '/')
    })

    it('takes the base URL of the innermost intercept', async () => {
      const ctx = await setup('file:///app/')
      const inner = ctx.intercept('std:fs', { baseUrl: 'mem://bucket/' }).intercept('std:fs', { baseUrl: 'file:///data/' })
      expect(inner.std.fs.resolve('a.txt').href).to.equal('file:///data/a.txt')
      expect(ctx.std.fs.resolve('a.txt').href).to.equal('file:///app/a.txt')
    })

    it('resolves a relative base URL against the outer one', async () => {
      const ctx = await setup('file:///app/')
      const inner = ctx.intercept('std:fs', { baseUrl: 'data/' }).intercept('std:fs', { baseUrl: '../logs/' })
      expect(inner.std.fs.baseUrl?.href).to.equal('file:///app/logs/')
      expect(inner.std.fs.resolve('a.txt').href).to.equal('file:///app/logs/a.txt')
    })

    it.each(['mem:bucket', 'mem:bucket/'])('rejects a base URL with an opaque path, such as %s', async (baseUrl) => {
      const root = new Context()
      const fiber = root.plugin(Fs, { baseUrl })
      fibers.push(fiber)
      await fiber.await().catch(() => {})
      expect(fiber.state).to.equal(FiberState.FAILED)
      const ctx = await setup('file:///app/')
      expect(() => ctx.intercept('std:fs', { baseUrl }).std.fs.baseUrl).to.throw(TypeError)
    })

    it('takes a base URL as a directory without a query or fragment', async () => {
      const ctx = await setup('file:///app?x#y')
      const inner = ctx.intercept('std:fs', { baseUrl: 'data' })
      expect(ctx.std.fs.baseUrl?.href).to.equal('file:///app/')
      expect(inner.std.fs.baseUrl?.href).to.equal('file:///app/data/')
    })

    it('rejects a base URL that is not a location', async () => {
      const root = new Context()
      const fiber = root.use(Fs, { baseUrl: 'mem://bucket/%2F' })
      fibers.push(fiber)
      await fiber.await().catch(() => {})
      expect(fiber.state).to.equal(FiberState.FAILED)
      const ctx = await setup('mem://bucket/')
      expect(() => ctx.intercept('std:fs', { baseUrl: 'mem://bucket/100%/' }).std.fs.baseUrl).to.throw(TypeError)
    })

    it('rejects a URL that cannot be parsed with `InvalidPath`', async () => {
      const ctx = await setup('file:///app/')
      expect(() => ctx.std.fs.resolve('http://[')).to.throw(FsError).with.property('code', 'InvalidPath')
    })

        it('watches the resolved location', async () => {
      const ctx = await setup('mem://bucket/dir/')
      const provider = fakeProvider()
      ctx.std.fs.mount('mem:', provider)
      ctx.std.fs.watch('a.txt')
      expect(provider.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/dir/a.txt'])
    })
  })

  function recorder() {
    const calls: [string, ...any[]][] = []
    const provider: FsProvider = {
      async read(url) { calls.push(['read', url.href]); return { stream: new Blob(['foo']).stream() } },
      async write(url, body) { calls.push(['write', url.href, await new Response(body).text()]); return {} },
      async access(url, mode) { calls.push(['access', url.href, mode]) },
      async rename(src, dest) { calls.push(['rename', src.href, dest.href]) },
      async remove(url, options) { calls.push(['remove', url.href, options]) },
      async stat(url, options) {
        calls.push(['stat', url.href, options])
        return { type: 'file', size: 0, mtime: new Date(0) }
      },
      async* readdir(url) {
        calls.push(['readdir', url.href])
        yield { name: 'a.txt', type: 'file' }
      },
      async mkdir(url, options) { calls.push(['mkdir', url.href, options]) },
      async symlink(target, url) { calls.push(['symlink', target, url.href]) },
      async readlink(url) { calls.push(['readlink', url.href]); return { target: 'a.txt' } },
    }
    return { calls, provider }
  }

  async function code(promise: Promise<unknown>) {
    const error = await promise.then(() => undefined, error => error)
    expect(error).to.be.instanceOf(FsError)
    return error.code
  }

  describe('operations', () => {
    it('forwards each operation to the provider of its location', async () => {
      const ctx = await setup('mem://bucket/dir/')
      const { calls, provider } = recorder()
      ctx.std.fs.mount('mem:', provider)

      const file = ctx.std.fs.file('a.txt')
      expect(file.url.href).to.equal('mem://bucket/dir/a.txt')
      expect(await file.text()).to.equal('foo')
      await file.write('bar')
      await ctx.std.fs.access('a.txt', 'write')
      await ctx.std.fs.rename('a.txt', 'b.txt')
      await ctx.std.fs.remove('b.txt')
      await ctx.std.fs.remove('b.txt', { recursive: true })
      await ctx.std.fs.stat('a.txt')
      await ctx.std.fs.stat('a.txt', { follow: false })
      for await (const _ of ctx.std.fs.readdir('.')) {}
      await ctx.std.fs.mkdir('sub')
      await ctx.std.fs.mkdir('sub', { recursive: true })
      await ctx.std.fs.symlink('../a.txt', 'link')
      expect(await ctx.std.fs.readlink('link')).to.equal('a.txt')
      expect(calls).to.deep.equal([
        ['read', 'mem://bucket/dir/a.txt'],
        ['write', 'mem://bucket/dir/a.txt', 'bar'],
        ['access', 'mem://bucket/dir/a.txt', 'write'],
        ['rename', 'mem://bucket/dir/a.txt', 'mem://bucket/dir/b.txt'],
        ['remove', 'mem://bucket/dir/b.txt', { recursive: false }],
        ['remove', 'mem://bucket/dir/b.txt', { recursive: true }],
        ['stat', 'mem://bucket/dir/a.txt', { follow: true }],
        ['stat', 'mem://bucket/dir/a.txt', { follow: false }],
        ['readdir', 'mem://bucket/dir/'],
        ['mkdir', 'mem://bucket/dir/sub', { recursive: false }],
        ['mkdir', 'mem://bucket/dir/sub', { recursive: true }],
        ['symlink', '../a.txt', 'mem://bucket/dir/link'],
        ['readlink', 'mem://bucket/dir/link'],
      ])
    })

    it('routes a reference when an operation is performed', async () => {
      const ctx = await setup()
      const file = ctx.std.fs.file('mem://bucket/a.txt')
      expect(await code(file.text())).to.equal('NoProvider')
      const entries = ctx.std.fs.dir('mem://bucket/').list()[Symbol.asyncIterator]()

      const { calls, provider } = recorder()
      ctx.std.fs.mount('mem:', provider)
      await file.text()
      expect((await entries.next()).value?.name).to.equal('a.txt')
      expect(calls).to.deep.equal([['read', 'mem://bucket/a.txt'], ['readdir', 'mem://bucket/']])
    })

    it('rejects with `NotSupported` for an operation the provider does not implement', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {})
      expect(await code(ctx.std.fs.file('mem://a.txt').text())).to.equal('NotSupported')
      expect(await code(ctx.std.fs.file('mem://a.txt').write(''))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.access('mem://a.txt', 'write'))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.rename('mem://a.txt', 'mem://b.txt'))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.remove('mem://a.txt'))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.stat('mem://a.txt'))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.exists('mem://a.txt'))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.readdir('mem://dir')[Symbol.asyncIterator]().next())).to.equal('NotSupported')
      expect(await code(ctx.std.fs.mkdir('mem://dir'))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.copy('mem://a.txt', 'mem://b.txt'))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.symlink('a.txt', 'mem://link'))).to.equal('NotSupported')
      expect(await code(ctx.std.fs.readlink('mem://link'))).to.equal('NotSupported')
    })

    it('resolves `exists()` to `false` only for `NotFound` and `NotADirectory`', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {
        async stat(url) {
          const failure = url.pathname.slice(1) as FsError.Code
          if (failure) throw new FsError(failure, url, failure)
          return { type: 'directory', size: 0, mtime: new Date(0) }
        },
      })
      expect(await ctx.std.fs.exists('mem:///')).to.be.true
      expect(await ctx.std.fs.exists('mem:///NotFound')).to.be.false
      expect(await ctx.std.fs.exists('mem:///NotADirectory')).to.be.false
      expect(await code(ctx.std.fs.exists('mem:///PermissionDenied'))).to.equal('PermissionDenied')
    })

    it('rejects a link target that is not a string with a `TypeError`', async () => {
      const ctx = await setup()
      const { calls, provider } = recorder()
      ctx.std.fs.mount('mem:', provider)
      const error = await ctx.std.fs.symlink(new URL('mem://a.txt') as any, 'mem://link').catch(error => error)
      expect(error).to.be.instanceOf(TypeError)
      expect(calls).to.deep.equal([])
    })
    it('rejects an unknown access mode before forwarding it', async () => {
      const ctx = await setup()
      const { calls, provider } = recorder()
      ctx.std.fs.mount('mem:', provider)
      const error = await ctx.std.fs.access('mem://a.txt', 'execute' as any).catch(error => error)
      expect(error).to.be.instanceOf(TypeError)
      expect(calls).to.deep.equal([])
    })

    it('rejects a rename between two mounts with `CrossesDevices`', async () => {
      const ctx = await setup()
      const outer = recorder()
      const inner = recorder()
      ctx.std.fs.mount('mem:', outer.provider)
      ctx.std.fs.mount('mem://bucket/', inner.provider)
      expect(await code(ctx.std.fs.rename('mem://other/a.txt', 'mem://bucket/a.txt'))).to.equal('CrossesDevices')
      expect([...outer.calls, ...inner.calls]).to.deep.equal([])
    })

    it('ignores only a missing location in a forced removal', async () => {
      const ctx = await setup()
      let failure: FsError.Code = 'NotFound'
      ctx.std.fs.mount('mem:', {
        async remove(url) { throw new FsError(failure, url, failure) },
      })
      expect(await code(ctx.std.fs.remove('mem://a.txt'))).to.equal('NotFound')
      await ctx.std.fs.remove('mem://a.txt', { force: true })
      failure = 'PermissionDenied'
      expect(await code(ctx.std.fs.remove('mem://a.txt', { force: true }))).to.equal('PermissionDenied')
    })
  })

  describe('dir', () => {
    function lister(names: string[]): FsProvider {
      return {
        async* readdir() {
          for (const name of names) yield { name, type: 'file' }
        },
      }
    }

    async function list(ctx: Context, path: string) {
      const urls: string[] = []
      for await (const entry of ctx.std.fs.dir(path).list()) urls.push(entry.url.href)
      return urls
    }

    it('resolves a directory with a trailing separator', async () => {
      const ctx = await setup('file:///app/')
      const dir = ctx.std.fs.dir('data')
      expect(dir.url.href).to.equal('file:///app/data/')
      expect(dir.name).to.equal('data')
      expect(ctx.std.fs.dir('data/').url.href).to.equal('file:///app/data/')
      expect(ctx.std.fs.dir(['data']).url.href).to.equal('file:///app/data/')
    })

    it('resolves a path against the directory', async () => {
      const ctx = await setup('file:///app/')
      const dir = ctx.std.fs.dir('data')
      expect(dir.file('a.txt').url.href).to.equal('file:///app/data/a.txt')
      expect(dir.dir('sub').file('b.txt').url.href).to.equal('file:///app/data/sub/b.txt')
      expect(dir.file('../x').url.href).to.equal('file:///app/x')
      expect(dir.file('/x').url.href).to.equal('file:///x')
    })

    it('does not change the URL that it is created from', async () => {
      const ctx = await setup()
      const file = ctx.std.fs.file('mem://bucket/a.txt')
      expect(ctx.std.fs.dir(file.url).url.href).to.equal('mem://bucket/a.txt/')
      expect(file.url.href).to.equal('mem://bucket/a.txt')
    })

    it('rejects a URL with an opaque path with `InvalidPath`', async () => {
      const ctx = await setup()
      expect(() => ctx.std.fs.dir('doc:record')).to.throw(FsError).with.property('code', 'InvalidPath')
      expect(() => new DirRef(ctx.std.fs, new URL('doc:record'))).to.throw(FsError).with.property('code', 'InvalidPath')
      expect(await code(ctx.std.fs.readdir('doc:record')[Symbol.asyncIterator]().next())).to.equal('InvalidPath')
    })

    it('gives the location of each entry below the listed directory', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', lister(['a.txt', 'a:b', 'a b', 'a%b', 'a?b', 'a#b', 'a\\b']))
      expect(await list(ctx, 'mem://bucket/dir')).to.deep.equal([
        'mem://bucket/dir/a.txt',
        'mem://bucket/dir/a:b',
        'mem://bucket/dir/a%20b',
        'mem://bucket/dir/a%25b',
        'mem://bucket/dir/a%3Fb',
        'mem://bucket/dir/a%23b',
        'mem://bucket/dir/a%5Cb',
      ])
    })

    it('decodes the location of an entry to its name', async () => {
      const names = ['a:b', 'a b', 'a%b', 'a?b', 'a#b', 'a\\b', 'é']
      const ctx = await setup()
      ctx.std.fs.mount('file:', lister(names))
      const decoded: string[] = []
      for await (const { url } of ctx.std.fs.dir('file:///dir/').list()) {
        decoded.push(decodeURIComponent(url.pathname.slice('/dir/'.length)))
      }
      expect(decoded).to.deep.equal(names)
    })

    it('lists a file and a directory as references to them, and another entry as a reference with its type', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {
        async* readdir() {
          yield { name: 'a #.txt', type: 'file' }
          yield { name: 'dir', type: 'directory' }
          yield { name: 'link', type: 'symlink' }
          yield { name: 'fifo', type: 'other' }
        },
        read: async () => ({ stream: new Blob(['foo']).stream() }),
      })
      const entries: Record<string, DirEntryRef> = {}
      for await (const entry of ctx.std.fs.dir('mem://bucket/').list()) entries[entry.name] = entry
      expect(Object.keys(entries).sort()).to.deep.equal(['a #.txt', 'dir', 'fifo', 'link'])
      const { 'a #.txt': file, dir, link, fifo } = entries
      expect(file.type).to.equal('file')
      expect(file).to.be.instanceOf(FileRef)
      if (file.type === 'file') expect(await file.text()).to.equal('foo')
      expect(dir.type).to.equal('directory')
      expect(dir).to.be.instanceOf(DirRef)
      expect(dir.url.href).to.equal('mem://bucket/dir/')
      if (dir.type === 'directory') expect(dir.file('b.txt').url.href).to.equal('mem://bucket/dir/b.txt')
      expect(link.type).to.equal('symlink')
      expect(fifo.type).to.equal('other')
      for (const entry of [link, fifo]) {
        expect(entry).to.be.instanceOf(EntryRef)
        expect(entry).not.to.be.instanceOf(FileRef)
        expect(entry).not.to.be.instanceOf(DirRef)
      }
    })

    it('resolves the entries of an iteration against the URL at its start', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', lister(['a.txt', 'b.txt']))
      const dir = ctx.std.fs.dir('mem://bucket/one/')
      const iterator = dir.list()[Symbol.asyncIterator]()
      await iterator.next()
      dir.url.pathname = '/two/'
      const { value } = await iterator.next()
      expect(new URL('.', value!.url).href).to.equal('mem://bucket/one/')
    })

    it('throws a failure from the iteration', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {
        async* readdir(url) {
          throw new FsError('NotFound', url, 'NotFound')
        },
      })
      const iterable = ctx.std.fs.dir('mem://bucket/dir').list()
      expect(await code(iterable[Symbol.asyncIterator]().next())).to.equal('NotFound')
    })
  })

  describe('copy', () => {
    // a provider of a tree of files and directories, which records the operations
    function tree(entries: Record<string, string | null>, options: { copy?: boolean, symlink?: boolean } = {}) {
      const calls: string[] = []
      const links: Record<string, string> = {}
      const find = (url: URL) => url.pathname.replace(/\/+$/, '')
      const missing = (url: URL) => new FsError('NotFound', url, 'NotFound')
      const provider: FsProvider = {
        capabilities: { exclusive: true },
        async stat(url, { follow }) {
          const path = find(url)
          if (path in links) {
            if (!follow) return { type: 'symlink', size: 0, mtime: new Date(0) }
            throw missing(url)
          }
          if (!(path in entries)) throw missing(url)
          return { type: entries[path] === null ? 'directory' : 'file', size: 0, mtime: new Date(0) }
        },
        async* readdir(url) {
          const path = find(url)
          for (const key of [...Object.keys(entries), ...Object.keys(links)]) {
            if (key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')) {
              yield { name: key.slice(path.length + 1), type: key in links ? 'symlink' : entries[key] === null ? 'directory' : 'file' }
            }
          }
        },
        async mkdir(url) {
          calls.push('mkdir ' + find(url))
          entries[find(url)] = null
        },
        async read(url) {
          calls.push('read ' + find(url))
          return { stream: new Blob([entries[find(url)]!]).stream() }
        },
        async write(url, body) {
          calls.push('write ' + find(url))
          entries[find(url)] = await new Response(body).text()
          return {}
        },
        async readlink(url) {
          return { target: links[find(url)] }
        },
      }
      if (options.copy) {
        provider.copy = async (src, dest) => {
          calls.push(`copy ${find(src)} ${find(dest)}`)
          entries[find(dest)] = entries[find(src)]
        }
      }
      if (options.symlink) {
        provider.symlink = async (target, url) => {
          calls.push(`symlink ${target} ${find(url)}`)
          links[find(url)] = target
        }
      }
      return { calls, entries, links, provider }
    }

    it('copies a file through the provider of the same mount', async () => {
      const ctx = await setup()
      const { calls, provider } = tree({ '/src': null, '/src/a.txt': 'foo' }, { copy: true })
      ctx.std.fs.mount('mem:', provider)
      await ctx.std.fs.copy('mem:///src', 'mem:///dest', { recursive: true })
      expect(calls).to.deep.equal(['mkdir /dest', 'copy /src/a.txt /dest/a.txt'])
    })

    it('copies a location without a hierarchical path to another key that extends it', async () => {
      const ctx = await setup()
      const written: string[] = []
      ctx.std.fs.mount('doc:', {
        async stat(url) { return { type: 'file', size: 6, mtime: new Date(0) } },
        read: async () => ({ stream: new Blob(['source']).stream() }),
        async write(url) { written.push(url.href); return {} },
      })
      await ctx.std.fs.copy('doc:entry', 'doc:entry/')
      await ctx.std.fs.copy('doc:entry', 'doc:entry/child')
      expect(written).to.deep.equal(['doc:entry/', 'doc:entry/child'])
      expect(await code(ctx.std.fs.copy('doc:entry', 'doc:entry'))).to.equal('InvalidPath')
    })

    it('copies a file between two mounts through a read and a write', async () => {
      const ctx = await setup()
      const source = tree({ '/a.txt': 'foo' }, { copy: true })
      const target = tree({}, { copy: true })
      ctx.std.fs.mount('mem:', source.provider)
      ctx.std.fs.mount('other:', target.provider)
      await ctx.std.fs.copy('mem:///a.txt', 'other:///b.txt')
      expect(target.entries['/b.txt']).to.equal('foo')
      expect([...source.calls, ...target.calls]).to.deep.equal(['read /a.txt', 'write /b.txt'])
    })

    it('rejects a known occupied exclusive destination before opening the source', async () => {
      const ctx = await setup()
      const source = tree({ '/file': 'new' })
      const target = tree({ '/file': 'old' })
      target.links['/link'] = 'file'
      const write = vi.fn(async (url: URL) => { throw new FsError('AlreadyExists', url, 'occupied') })
      ctx.std.fs.mount('src:', source.provider)
      const realpath = async (url: URL) => ({ url: new URL(url.href.replace(/\/link$/, '/file')) })
      ctx.std.fs.mount('dest:', { ...target.provider, write, realpath })
      expect(await code(ctx.std.fs.copy('src:///file', 'dest:///link', { exclusive: true }))).to.equal('AlreadyExists')
      expect(source.calls).to.deep.equal([])
      expect(write).not.toHaveBeenCalled()
    })

    it('copies through the provider, natively atomic or to a temporary file, without `write()`', async () => {
      const ctx = await setup()
      for (const atomic of [false, true]) {
        const scheme = atomic ? 'native:' : 'staged:'
        const target = tree({ '/a': 'new', '/b': 'old' }, { copy: true })
        ctx.std.fs.mount(scheme, {
          stat: target.provider.stat, capabilities: { atomic, exclusive: true },
          async copy(src, dest, options) {
            if (atomic) expect(options.atomic).to.equal(true)
            else expect(target.entries['/b']).to.equal('old')
            await target.provider.copy!(src, dest, options)
          },
          async rename(src, dest) {
            target.entries[dest.pathname] = target.entries[src.pathname]
            delete target.entries[src.pathname]
          },
          async remove(url) { delete target.entries[url.pathname] },
        })
        await ctx.std.fs.copy(scheme + '///a', scheme + '///b', { atomic: true })
        expect(target.entries).to.deep.equal({ '/a': 'new', '/b': 'new' })
      }
    })

    it('streams cross-mount copies with the destination write guarantees', async () => {
      const ctx = await setup()
      const source = tree({ '/a': 'data' }, { copy: true })
      ctx.std.fs.mount('src:', source.provider)
      const received: string[] = []
      ctx.std.fs.mount('dest:', {
        capabilities: { atomic: true, exclusive: true },
        async write(url, body, options) {
          expect(options).to.include({ atomic: true, exclusive: true })
          received.push(await new Response(body).text())
          return {}
        },
      })
      await ctx.std.fs.copy('src:///a', 'dest:///b', { atomic: true, exclusive: true })
      expect(received).to.deep.equal(['data'])
    })

    it('releases the source reader when a cross-mount copy fails after opening a tee branch', async () => {
      const ctx = await setup()
      const [stream, sibling] = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])) },
      }).tee()
      ctx.std.fs.mount('src:', {
        stat: async () => ({ type: 'file', size: 1, mtime: new Date(0) }),
        read: async () => ({ stream }),
      })
      ctx.std.fs.mount('dest:', {
        async write(url) { throw new FsError('PermissionDenied', url, 'denied') },
      })
      const copy = code(ctx.std.fs.copy('src:///file', 'dest:///file'))
      try {
        expect(await copy).to.equal('PermissionDenied')
        expect(stream.locked).to.equal(false)
      } finally {
        await sibling.cancel()
      }
    })

    it('does not write the destination when the source cannot be read', async () => {
      const ctx = await setup()
      const target = tree({})
      ctx.std.fs.mount('mem:', {
        async stat() { return { type: 'file', size: 0, mtime: new Date(0) } },
        async read(url) {
          return { stream: new ReadableStream({
            start() { throw new FsError('PermissionDenied', url, 'PermissionDenied') },
          }) }
        },
      })
      ctx.std.fs.mount('other:', target.provider)
      expect(await code(ctx.std.fs.copy('mem:///a.txt', 'other:///b.txt'))).to.equal('PermissionDenied')
      expect(target.calls).to.deep.equal([])
    })

    it('does not open the source for a destination that cannot be written', async () => {
      const ctx = await setup()
      const source = tree({ '/a.txt': 'foo' })
      const { write: _, ...target } = tree({}).provider
      ctx.std.fs.mount('mem:', source.provider)
      ctx.std.fs.mount('other:', target)
      expect(await code(ctx.std.fs.copy('mem:///a.txt', 'other:///b.txt'))).to.equal('NotSupported')
      expect(source.calls).to.deep.equal([])
    })

    it('fails to copy a link to a provider without links before any change', async () => {
      const ctx = await setup()
      const source = tree({ '/src': null, '/src/a.txt': 'foo' }, { symlink: true })
      source.links['/src/link'] = 'a.txt'
      source.links['/link'] = 'src'
      const target = tree({ '/link': 'bar' })
      ctx.std.fs.mount('mem:', source.provider)
      ctx.std.fs.mount('other:', target.provider)
      expect(await code(ctx.std.fs.copy('mem:///link', 'other:///link'))).to.equal('NotSupported')
      expect(target.entries['/link']).to.equal('bar')
      await ctx.std.fs.copy('mem:///src', 'mem:///dest', { recursive: true })
      expect(source.links['/dest/link']).to.equal('a.txt')
    })

    it('fails on a destination at or below the source before any I/O', async () => {
      const ctx = await setup()
      const { calls, provider } = recorder()
      ctx.std.fs.mount('mem:', provider)
      for (const [src, dest] of [
        ['mem://bucket/dir', 'mem://bucket/dir/sub'],
        ['mem://bucket/dir/', 'mem://bucket/dir'],
        ['mem://bucket/a.txt', 'mem://bucket/a.txt'],
        ['mem://bucket/', 'mem://bucket/a.txt'],
      ]) {
        expect(await code(ctx.std.fs.copy(src, dest, { recursive: true }))).to.equal('InvalidPath')
      }
      expect(calls).to.deep.equal([])
      await ctx.std.fs.copy('mem://bucket/dir', 'mem://bucket/dir2')
    })

  })

  describe('file', () => {
    // a provider that serves `content` in chunks of `size` bytes, and stores what is written
    function memory(content: Uint8Array, size: number) {
      const written: Uint8Array[] = []
      const provider: FsProvider = {
        async read() {
          let offset = 0
          return {
            stream: new ReadableStream({
              pull(controller) {
                if (offset >= content.byteLength) return controller.close()
                controller.enqueue(content.slice(offset, offset += size))
              },
            }),
          }
        },
        async write(url, body) {
          written.push(new Uint8Array(await new Response(body).arrayBuffer()))
          return {}
        },
      }
      return { written, provider }
    }

    it('reads the content of a stream in several forms', async () => {
      const ctx = await setup()
      const json = '{"name":"cordis","emoji":"🌸"}'
      const content = new TextEncoder().encode(json)
      // chunks of 3 bytes split the 4 bytes of the emoji
      ctx.std.fs.mount('mem:', memory(content, 3).provider)
      const file = ctx.std.fs.file('mem://a.json')

      expect(await file.text()).to.equal(json)
      expect(await file.json()).to.deep.equal({ name: 'cordis', emoji: '🌸' })
      expect(await file.bytes()).to.deep.equal(content)
      expect(new Uint8Array(await file.arrayBuffer())).to.deep.equal(content)
      expect(await new Response(file.stream()).text()).to.equal(json)
    })

    it('writes each kind of data as a stream', async () => {
      const ctx = await setup()
      const { written, provider } = memory(new Uint8Array(), 1)
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file('mem://a.txt')
      const bytes = new TextEncoder().encode('花')

      await file.write('花')
      await file.write(bytes)
      await file.write(bytes.buffer)
      await file.write(new Blob([bytes]))
      await file.write(new Blob([bytes]).stream())
      expect(written).to.deep.equal(Array(5).fill(bytes))
    })

    it('rejects a write of a slice, also of the whole content', async () => {
      const ctx = await setup()
      const { written, provider } = memory(new Uint8Array(), 1)
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file('mem://a.txt')
      for (const slice of [file.slice(), file.slice(0), file.slice(1)]) {
        expect(await slice.write('foo').catch(error => error)).to.be.instanceOf(TypeError)
      }
      expect(written).to.deep.equal([])
    })

    it('rejects a read with the error of the stream', async () => {
      const ctx = await setup()
      const error = new FsError('NotFound', new URL('mem://a.txt'), 'missing')
      ctx.std.fs.mount('mem:', {
        read: async () => ({ stream: new ReadableStream({ start(controller) { controller.error(error) } }) }),
      })
      expect(await ctx.std.fs.file('mem://a.txt').text().catch(error => error)).to.equal(error)
    })
  })

  it('does not call a queued ready listener after the watch ends', async () => {
    const ctx = await setup()
    const provider = fakeProvider()
    ctx.std.fs.mount('mem:', provider)
    const watcher = ctx.std.fs.watch('mem://a.txt')
    const ready = vi.fn()
    watcher.emit('ready')
    watcher.on('ready', ready)

    await watcher.dispose()
    await new Promise(resolve => setImmediate(resolve))
    expect(ready).not.toHaveBeenCalled()
  })

  describe('atomic write', () => {
    // a provider of one directory that records the writes and the renames, and
    // fails the first renames with the given errors
    function directory(overrides?: Partial<FsProvider>, failures: FsError[] = []) {
      const files = new Map<string, string>()
      const calls: [string, ...unknown[]][] = []
      const provider: FsProvider = {
        async write(url, body, options) {
          calls.push(['write', url.href, options])
          files.set(url.href, await new Response(body).text())
          return {}
        },
        async rename(src, dest) {
          calls.push(['rename', src.href, dest.href])
          const failure = failures.shift()
          if (failure) throw failure
          files.set(dest.href, files.get(src.href)!)
          files.delete(src.href)
        },
        async remove(url) {
          calls.push(['remove', url.href])
          if (!files.delete(url.href)) throw new FsError('NotFound', url, 'missing')
        },
        ...overrides,
        capabilities: { exclusive: true, ...overrides?.capabilities },
      }
      return { files, calls, provider }
    }

    const busy = () => new FsError('Busy', new URL('mem://vol/dir/a.txt'), 'busy')

    it('forwards `atomic` only to a provider that declares `atomic`', async () => {
      const ctx = await setup()
      const { calls, provider } = directory({ capabilities: { atomic: true } })
      ctx.std.fs.mount('mem:', provider)
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true, mode: 0o600 })
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('bar', { atomic: false })
      expect(calls).to.deep.equal([
        ['write', 'mem://vol/dir/a.txt', { exclusive: false, atomic: true, mode: 0o600 }],
        ['write', 'mem://vol/dir/a.txt', { exclusive: false, atomic: false }],
      ])
    })

    it('writes a temporary file in the same directory and renames it over the target', async () => {
      const ctx = await setup()
      const { files, calls, provider } = directory()
      ctx.std.fs.mount('mem:', provider)
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true })
      expect([...files]).to.deep.equal([['mem://vol/dir/a.txt', 'foo']])
      const [[, temporary, options]] = calls
      expect(options).to.include({ exclusive: true })
      expect(calls.at(-1)).to.deep.equal(['rename', temporary, 'mem://vol/dir/a.txt'])
      const url = new URL(temporary as string)
      expect(new URL('./', url).href).to.equal('mem://vol/dir/')
    })

    it('creates the temporary file with content that can be read again in one write, also after a collision', async () => {
      const ctx = await setup()
      const { files, calls, provider } = directory()
      const write = provider.write!
      const read: string[] = []
      provider.write = async (url, body, options) => {
        if (read.length) return write(url, body, options)
        // the first attempt reads the whole content before it finds the name occupied
        read.push(await new Response(body).text())
        files.set(url.href, 'occupied')
        throw new FsError('AlreadyExists', url, 'occupied')
      }
      ctx.std.fs.mount('mem:', provider)
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true })
      expect(read).to.deep.equal(['foo'])
      expect([...files.values()]).to.deep.equal(['occupied', 'foo'])
      // no empty file precedes the content
      expect(calls.map(([name]) => name)).to.deep.equal(['write', 'rename'])
      expect(calls[0][2]).to.include({ exclusive: true })
    })

    it('checks the operations of a copy between two mounts before any change of the destination', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('src:', { stat: async () => ({ type: 'file', size: 4, mtime: new Date(0) }) })
      const { calls, provider } = directory({ stat: async url => { throw new FsError('NotFound', url, 'missing') } })
      ctx.std.fs.mount('mem:', provider)
      for (const atomic of [false, true]) {
        expect(await code(ctx.std.fs.copy('src:///a', 'mem://vol/dir/b', { atomic }))).to.equal('NotSupported')
      }
      expect(calls).to.deep.equal([])
    })

    it('retries only an `AlreadyExists` of the temporary file itself', async () => {
      const ctx = await setup()
      const failure = new FsError('AlreadyExists', new URL('mem://vol/dir/a'), 'of the source')
      const copy = vi.fn(async () => { throw failure })
      const { calls, provider } = directory({ copy, stat: async () => ({ type: 'file', size: 0, mtime: new Date(0) }) })
      ctx.std.fs.mount('mem:', provider)
      expect(await ctx.std.fs.copy('mem://vol/dir/a', 'mem://vol/dir/b', { atomic: true }).catch(error => error)).to.equal(failure)
      expect(copy).toHaveBeenCalledOnce()
      expect(calls).to.deep.equal([])
    })

    it('shares the retry of an occupied name between the two creations of an empty temporary file', async () => {
      const ctx = await setup()
      let creations = 0
      const { files, provider } = directory({
        async stat(url) {
          if (!files.has(url.href)) throw new FsError('NotFound', url, 'missing')
          return { type: 'file', size: 0, mtime: new Date(0), mode: 0o444 }
        },
      })
      const write = provider.write!
      provider.write = async (url, body, options) => {
        // the first creation of each of the two attempts finds its name occupied
        if (options.exclusive && ++creations % 2) throw new FsError('AlreadyExists', url, 'occupied')
        return write(url, body, options)
      }
      ctx.std.fs.mount('mem:', provider)
      expect(await code(ctx.std.fs.file('mem://vol/dir/a').write(new Blob(['data']).stream(), { atomic: true }))).to.equal('AlreadyExists')
      expect(creations).to.equal(3)
    })

    it('cancels the stream of a blob read by a failed attempt', async () => {
      const ctx = await setup()
      const streams: ReadableStream<Uint8Array>[] = []
      const stream = Blob.prototype.stream
      vi.spyOn(Blob.prototype, 'stream').mockImplementation(function (this: Blob) {
        const result = stream.call(this)
        streams.push(result)
        return result
      })
      const failure = new FsError('Unknown', new URL('mem://vol/dir/a'), 'failed')
      ctx.std.fs.mount('mem:', {
        async write(url, body) {
          const reader = body.getReader()
          await reader.read()
          reader.releaseLock()
          throw failure
        },
      })
      try {
        // a blob of two parts, which a stream reads as two chunks
        const data = new Blob([new Uint8Array(4), new Uint8Array(4)])
        expect(await ctx.std.fs.file('mem://vol/dir/a').write(data).catch(error => error)).to.equal(failure)
        expect((await streams.at(-1)!.getReader().read()).done).to.equal(true)
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('writes the bytes of a blob, also of a subclass with another `stream()`', async () => {
      const ctx = await setup()
      const { files, provider } = directory()
      ctx.std.fs.mount('mem:', provider)
      class Other extends Blob {
        stream() { return new Blob(['other']).stream() }
      }
      await ctx.std.fs.file('mem://vol/dir/a').write(new Other(['fixed']), { atomic: true })
      expect([...files.values()]).to.deep.equal(['fixed'])
    })

    it('retries a rename that fails with `Busy`', async () => {
      const ctx = await setup()
      const { files, calls, provider } = directory({}, [busy(), busy()])
      ctx.std.fs.mount('mem:', provider)
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true })
      expect([...files]).to.deep.equal([['mem://vol/dir/a.txt', 'foo']])
      expect(calls.filter(([name]) => name === 'rename')).to.have.length(3)
    })

    it('fails with the second collision of an empty temporary file, and keeps both occupied entries', async () => {
      const ctx = await setup()
      const collisions: FsError[] = []
      const { files, provider } = directory({
        async write(url) {
          files.set(url.href, 'occupied')
          const error = new FsError('AlreadyExists', url, 'occupied')
          collisions.push(error)
          throw error
        },
      })
      ctx.std.fs.mount('mem:', provider)
      const dest = ctx.std.fs.file('mem://vol/dir/a.txt')
      files.set(dest.url.href, 'old')
      const pull = vi.fn()
      const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 })
      const error = await dest.write(body, { atomic: true }).catch(error => error)
      expect(collisions).to.have.length(2)
      expect(error).to.equal(collisions[1])
      expect([...files.values()]).to.deep.equal(['old', 'occupied', 'occupied'])
      expect(pull).not.toHaveBeenCalled()
    })

    it('removes the temporary file when the rename fails', async () => {
      const ctx = await setup()
      const failure = new FsError('PermissionDenied', new URL('mem://vol/dir/a.txt'), 'denied')
      const { files, provider } = directory({}, [failure])
      ctx.std.fs.mount('mem:', provider)
      expect(await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true }).catch(error => error)).to.equal(failure)
      expect([...files]).to.deep.equal([])
    })

    it('removes an empty temporary file of a read-only mode whose first removal fails', async () => {
      const ctx = await setup()
      const { files, provider } = directory({
        async stat(url) {
          if (!files.has(url.href)) throw new FsError('NotFound', url, 'missing')
          return { type: 'file', size: 0, mtime: new Date(0), mode: 0o444 }
        },
      })
      const failure = busy()
      provider.remove = vi.fn(provider.remove!).mockRejectedValueOnce(failure)
      ctx.std.fs.mount('mem:', provider)
      const body = new Blob(['data']).stream()
      await expect(ctx.std.fs.file('mem://vol/dir/a.txt').write(body, { atomic: true })).rejects.toBe(failure)
      expect(files.size).to.equal(0)
    })

    it('keeps a replacement when removal took effect before reporting an error', async () => {
      const ctx = await setup()
      let ino = 1n
      const { files, provider } = directory({
        async stat(url) {
          if (!files.has(url.href)) throw new FsError('NotFound', url, 'missing')
          return { type: 'file', size: 0, mtime: new Date(0), mode: 0o444, ino, dev: 1n }
        },
      })
      const failure = new Error('lost removal acknowledgement')
      provider.remove = vi.fn(provider.remove!).mockImplementationOnce(async (url) => {
        files.set(url.href, 'replacement')
        ino++
        throw failure
      })
      ctx.std.fs.mount('mem:', provider)
      const body = new Blob(['data']).stream()
      await expect(ctx.std.fs.file('mem://vol/dir/a.txt').write(body, { atomic: true })).rejects.toBe(failure)
      expect([...files.values()]).to.deep.equal(['replacement'])
    })

    it('keeps the permission bits of an existing file unless `mode` is given', async () => {
      const ctx = await setup()
      const { calls, provider } = directory({
        stat: async () => ({ type: 'file', size: 0, mtime: new Date(0), mode: 0o600 }),
      })
      ctx.std.fs.mount('mem:', provider)
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true })
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true, mode: 0o644 })
      const writes = calls.filter(([name]) => name === 'write').map(call => (call[2] as WriteOptions).mode)
      expect(writes).to.deep.equal([0o600, 0o644])
    })

    it('fails with the denial of a plain write to an existing file before writing', async () => {
      const ctx = await setup()
      const denied = new FsError('PermissionDenied', new URL('mem://vol/dir/a.txt'), 'denied')
      const { calls, provider } = directory({
        stat: async () => ({ type: 'file', size: 0, mtime: new Date(0) }),
        access: async () => { throw denied },
      })
      ctx.std.fs.mount('mem:', provider)
      expect(await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true }).catch(error => error)).to.equal(denied)
      expect(calls).to.deep.equal([])
    })

    it('fails with `NotSupported` before any call without the capability `exclusive`', async () => {
      const ctx = await setup()
      const stat = vi.fn(async () => ({ type: 'file' as const, size: 0, mtime: new Date(0) }))
      const { calls, provider } = directory({ capabilities: { exclusive: false }, stat, copy: vi.fn() })
      ctx.std.fs.mount('mem:', provider)
      for (const pending of [
        ctx.std.fs.file('mem://vol/dir/a').write('data', { exclusive: true }),
        ctx.std.fs.file('mem://vol/dir/a').write('data', { atomic: true }),
        ctx.std.fs.copy('mem://vol/dir/a', 'mem://vol/dir/b', { exclusive: true }),
      ]) {
        expect(await code(pending)).to.equal('NotSupported')
      }
      expect(calls).to.deep.equal([])
      expect(provider.copy).not.toHaveBeenCalled()
      // only the type of the source of the copy is queried
      expect(stat).toHaveBeenCalledOnce()
    })

    it.each(['rename', 'remove'] as const)('fails with `NotSupported` without `%s()` before any change, and cancels the body', async (name) => {
      const ctx = await setup()
      const cancel = vi.fn()
      const { calls, provider } = directory()
      delete provider[name]
      ctx.std.fs.mount('mem:', provider)
      const body = new ReadableStream({ cancel })
      expect(await code(ctx.std.fs.file('mem://vol/dir/a.txt').write(body, { atomic: true }))).to.equal('NotSupported')
      expect(calls).to.deep.equal([])
      expect(cancel).toHaveBeenCalled()
    })

    // a provider of the directory `mem://vol/dir/` whose links are the given entries
    function links(entries: Record<string, string>, overrides?: Partial<FsProvider>) {
      const lookups: string[] = []
      const result = directory({
        async stat(url) {
          lookups.push(url.href)
          if (entries[url.href] !== undefined) return { type: 'symlink', size: 0, mtime: new Date(0) }
          throw new FsError('NotFound', url, 'missing')
        },
        readlink: async url => ({ target: entries[url.href] }),
        ...overrides,
      })
      return { ...result, lookups }
    }

    it('writes to the location itself through a provider without `realpath()`', async () => {
      const ctx = await setup()
      const readlink = vi.fn()
      const { files, lookups, provider } = links({}, { readlink })
      ctx.std.fs.mount('mem:', provider)
      ctx.std.fs.mount('mem://vol/overlay/', {})
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { exclusive: true })
      expect(lookups).to.deep.equal([])
      expect(readlink).not.toHaveBeenCalled()
      expect([...files]).to.deep.equal([['mem://vol/dir/a.txt', 'foo']])
    })

    it.each([false, true])('fails with `NotSupported` before any query to stage a location without a hierarchical path (realpath: %s)', async (resolve) => {
      const ctx = await setup()
      const stat = vi.fn(async (url: URL): Promise<never> => { throw new FsError('PermissionDenied', url, 'denied') })
      const realpath = resolve ? async () => ({ url: new URL('doc:record') }) : undefined
      // the mount at the empty prefix also serves `doc:record`
      ctx.std.fs.mount('', { ...directory().provider, stat, realpath })
      ctx.std.fs.mount('other:', {})
      const url = resolve ? 'mem://vol/dir/a' : 'doc:record'
      expect(await code(ctx.std.fs.file(url).write('foo', { atomic: true }))).to.equal('NotSupported')
      expect(stat).not.toHaveBeenCalled()
    })

    it.each(['stat, readlink', 'stat', 'none'])('writes through a link resolved by `realpath()` (other operations: %s)', async (operations) => {
      const ctx = await setup()
      const realpath = vi.fn(async (url: URL) => ({ url: new URL('../other/c.txt', url) }))
      const { files, provider } = links({ 'mem://vol/dir/a.txt': '../x/../other/c.txt' }, { realpath })
      if (!operations.includes('readlink')) delete provider.readlink
      if (!operations.includes('stat')) delete provider.stat
      ctx.std.fs.mount('mem:', provider)
      await ctx.std.fs.file('mem://vol/dir/a.txt').write('foo', { atomic: true })
      expect([...files]).to.deep.equal([['mem://vol/other/c.txt', 'foo']])
    })

    it('queries only the last component of the only mount at the empty prefix', async () => {
      const ctx = await setup()
      const { lookups, provider } = links({}, { realpath: vi.fn() })
      ctx.std.fs.mount('', provider)
      await ctx.std.fs.file('mem://vol/a/b/c/d/file').write('one', { exclusive: true })
      expect(lookups).to.deep.equal(['mem://vol/a/b/c/d/file'])
      expect(provider.realpath).not.toHaveBeenCalled()
    })

    it('names a location resolved by `realpath()` through the prefix of a mount at a path', async () => {
      const ctx = await setup()
      const targets: Record<string, string> = { 'mem://vol/app/link': 'mem://real/app/target', 'mem://vol/app/root': 'mem://real/app' }
      const { files, provider } = links(targets, {
        async realpath(url) { return { url: new URL(targets[url.href] ?? url.href.replace('mem://vol/app/', 'mem://real/app/')) } },
      })
      ctx.std.fs.mount('mem://vol/app/', provider)
      await ctx.std.fs.file('mem://vol/app/link').write('data', { atomic: true })
      expect([...files]).to.deep.equal([['mem://vol/app/target', 'data']])
      expect(await code(ctx.std.fs.file('mem://vol/app/root').write('data', { exclusive: true }))).to.equal('IsADirectory')
    })

    it.each([
      [['mem:', 'mem://vol/overlay/'], 'mem://vol/alias/file', 'mem://vol/overlay/file'],
      [['', 'other:'], 'mem://vol/link', 'other://vol/target'],
      [['mem://one/', 'mem://two/'], 'mem://one/alias/file', 'mem://two/file'],
      [['view:', 'store:'], 'view://vol/alias/file', 'store://vol/file'],
      [['view:'], 'view://vol/alias/file', 'store://vol/file'],
    ])('fails with `CrossesDevices` where `realpath()` leads out of the mount (%j)', async ([prefix, ...others], url, real) => {
      const ctx = await setup()
      const { files, provider } = links({ [url]: 'link' }, {
        async realpath(location) {
          // the root of a host is not a path of a directory on every storage
          if (location.pathname === '/') throw new FsError('InvalidPath', location, 'not a directory')
          return { url: new URL(real) }
        },
      })
      const other = directory({ capabilities: { atomic: true } })
      ctx.std.fs.mount(prefix, provider)
      for (const key of others) ctx.std.fs.mount(key, other.provider)
      for (const options of [{ atomic: true }, { exclusive: true }]) {
        expect(await code(ctx.std.fs.file(url).write('data', options))).to.equal('CrossesDevices')
      }
      expect(files.size + other.files.size).to.equal(0)
    })

    it('reports the destination of an atomic write named like a temporary file, and not its temporary file', async () => {
      const ctx = await setup()
      const { provider } = directory()
      const url = new URL('mem://vol/dir/.notes.0123456789ab.tmp')
      ctx.std.fs.mount('mem:', {
        ...provider, ...fakeProvider(),
        async write(dest, body, options) {
          const result = await provider.write!(dest, body, options)
          watcher.emit('change', dest)
          return result
        },
        async rename(from, to) {
          await provider.rename!(from, to)
          watcher.emit('change', to)
        },
      })
      const watcher = ctx.std.fs.watch('mem://vol/dir')
      const seen: string[] = []
      watcher.on('change', dest => { seen.push(dest.href) })
      await ctx.std.fs.file(url).write('content', { atomic: true })
      expect(seen).to.deep.equal([url.href])
    })

    it('writes and copies to a location without a hierarchical path, whose trailing `/` is a part of its name', async () => {
      const ctx = await setup()
      const written: string[] = []
      ctx.std.fs.mount('doc:', {
        capabilities: { atomic: true, exclusive: true },
        realpath: async url => ({ url }),
        async stat(url) {
          if (url.href === 'doc:source') return { type: 'file', size: 6, mtime: new Date(0) }
          throw new FsError('NotFound', url, 'missing')
        },
        read: async () => ({ stream: new Blob(['source']).stream() }),
        async write(url, body) { written.push(url.href + ' ' + await new Response(body).text()); return {} },
      })
      await ctx.std.fs.file('doc:entry/').write('data', { atomic: true, exclusive: true })
      await ctx.std.fs.copy('doc:source', 'doc:copy/', { atomic: true, exclusive: true })
      expect(written).to.deep.equal(['doc:entry/ data', 'doc:copy/ source'])
    })

    it('reports an unsupported write while the other branch of a tee is still open', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', { async write() { return {} } })
      const [body, sibling] = new ReadableStream<Uint8Array>().tee()
      const pending = code(ctx.std.fs.file('mem://vol/a').write(body, { atomic: true }))
      try {
        expect(await pending).to.equal('NotSupported')
      } finally {
        await sibling.cancel()
      }
    })
  })

  describe('provider ranges', () => {
    // a provider of one file, which records the options of its reads
    function single(capabilities: FsProvider.Capabilities) {
      const options: object[] = []
      const provider: FsProvider = {
        capabilities,
        async read(url, value) {
          options.push(value)
          return { stream: new Blob(['0123456789']).slice(value.start, value.end).stream() }
        },
      }
      return { options, provider }
    }

    it.each(['unsigned', 'signed'] as const)('forwards supported bounds without stat (%s)', async (range) => {
      const ctx = await setup()
      const { options, provider } = single({ range })
      const stat = vi.fn(async () => ({ type: 'file' as const, size: 10, mtime: new Date(0) }))
      ctx.std.fs.mount('mem:', { ...provider, stat })
      const file = ctx.std.fs.file('mem://a.txt')
      const start = range === 'signed' ? -3 : 3
      await file.text()
      await file.slice(start, 8).text()
      expect(options).to.deep.equal([{}, { start, end: 8 }])
      expect(stat).not.toHaveBeenCalled()
    })

    it.each(['unsigned', 'signed'] as const)('resolves a slice chain to one range using the file size (%s)', async (range) => {
      const ctx = await setup()
      const { options, provider } = single({ range })
      ctx.std.fs.mount('mem:', {
        ...provider,
        stat: async () => ({ type: 'file', size: 10, mtime: new Date(0) }),
      })
      const file = ctx.std.fs.file('mem://a.txt')
      expect(await file.slice(1).slice(-1).text()).to.equal('9')
      expect(await file.slice(7, 20).slice(-2, -1).text()).to.equal('8')
      expect(options).to.deep.equal([{ start: 9, end: 10 }, { start: 8, end: 9 }])
    })

    it('resolves a single negative bound for an unsigned provider', async () => {
      const ctx = await setup()
      const { options, provider } = single({ range: 'unsigned' })
      ctx.std.fs.mount('mem:', {
        ...provider,
        stat: async () => ({ type: 'file', size: 10, mtime: new Date(0) }),
      })
      expect(await ctx.std.fs.file('mem://a.txt').slice(-3, 9).text()).to.equal('78')
      expect(options).to.deep.equal([{ start: 7, end: 9 }])
    })

    it('merges a slice into the preceding one where the two select the range of one slice', async () => {
      const ctx = await setup()
      const { options, provider } = single({ range: 'signed' })
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file('mem://a.txt')
      const pairs: [FileRef, FileRef][] = [
        [file.slice().slice(-1), file.slice(-1)],
        [file.slice(-3).slice(0), file.slice(-3)],
        [file.slice(2, 8).slice(1, 3), file.slice(3, 5)],
        [file.slice(-5).slice(-2), file.slice(-2)],
        [file.slice(-2).slice(-5), file.slice(-2)],
        [file.slice(1, -1).slice(2, -3), file.slice(3, -4)],
        [file.slice(1).slice(0, -2), file.slice(1, -2)],
      ]
      for (const [chain, one] of pairs) {
        options.length = 0
        expect(await chain.text()).to.equal(await one.text())
        expect(options[0]).to.deep.equal(options[1])
      }
    })

    it('reads sequentially without querying metadata when the provider declares no range capability', async () => {
      const ctx = await setup()
      const { options, provider } = single({})
      const stat = vi.fn(async () => { throw new Error('unexpected stat') })
      ctx.std.fs.mount('mem:', { ...provider, stat })
      expect(await ctx.std.fs.file('mem://a.txt').slice(-3, 9).text()).to.equal('78')
      expect(options).to.deep.equal([{}])
      expect(stat).not.toHaveBeenCalled()
    })

    it.each(['unsigned', 'signed'] as const)('uses only supported bounds when stat fails (%s)', async (range) => {
      const ctx = await setup()
      const { options, provider } = single({ range })
      ctx.std.fs.mount('mem:', {
        ...provider,
        async stat() { throw new Error('metadata unavailable') },
      })
      const file = ctx.std.fs.file('mem://a.txt')
      expect(await file.slice(-3).slice(1, 2).text()).to.equal('8')
      expect(await file.slice(1).slice(-1).text()).to.equal('9')
      expect(options).to.deep.equal([range === 'signed' ? { start: -3 } : {}, { start: 1 }])
    })

    it('propagates a read error after an unsuccessful stat', async () => {
      const ctx = await setup()
      const failure = new Error('open failed')
      ctx.std.fs.mount('mem:', {
        capabilities: { range: 'unsigned' },
        async stat() { throw new Error('metadata unavailable') },
        read: async () => ({ stream: new ReadableStream({ start: controller => controller.error(failure) }) }),
      })
      const reader = ctx.std.fs.file('mem://a.txt').slice(1).slice(-1).stream().getReader()
      expect(await reader.read().catch(error => error)).to.equal(failure)
    })

    it('leaves the source unopened when cancelled during stat', async () => {
      const ctx = await setup()
      const { options, provider } = single({ range: 'unsigned' })
      const pending = Promise.withResolvers<void>()
      ctx.std.fs.mount('mem:', {
        ...provider,
        async stat() {
          await pending.promise
          return { type: 'file', size: 10, mtime: new Date(0) }
        },
      })
      const reader = ctx.std.fs.file('mem://a.txt').slice(-1).stream().getReader()
      const reading = reader.read()
      await reader.cancel()
      pending.resolve()
      await reading
      await new Promise(resolve => setImmediate(resolve))
      expect(options).to.deep.equal([])
    })
  })

  describe('range', () => {
    it('cuts a range with a negative bound from the whole content without `stat`', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', { read: async () => ({ stream: new Blob(['0123456789']).stream() }) })
      const file = ctx.std.fs.file('mem://a.txt')
      expect(await file.slice(-3).text()).to.equal('789')
      expect(await file.slice(2, -2).slice(-3, -1).text()).to.equal('56')
      expect(await file.slice(2, 5).text()).to.equal('234')
    })

    it('counts bytes beyond an absolute end when the start is relative to EOF', async () => {
      const ctx = await setup()
      let content = ''
      ctx.std.fs.mount('mem:', {
        read: async () => ({ stream: new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(content)
            for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3))
            controller.close()
          },
        }) }),
      })
      const file = ctx.std.fs.file('mem://a.txt')
      for (const input of ['a', 'abcd', 'abcde', 'abcdef', 'abcdefgh']) {
        content = input
        for (const [start, end] of [[-4, 2], [-2, 5]]) {
          const bytes = await file.slice(start, end).arrayBuffer()
          expect(new TextDecoder().decode(bytes)).to.equal(content.slice(start, end))
        }
      }
    })

    it('stops reading the source at the end of a range', async () => {
      const ctx = await setup()
      let pulls = 0
      ctx.std.fs.mount('mem:', {
        read: async () => ({ stream: new ReadableStream({
          pull(controller) {
            pulls++
            controller.enqueue(new Uint8Array(4).fill(pulls))
          },
        }, { highWaterMark: 0 }) }),
      })
      expect(await ctx.std.fs.file('mem://a.bin').slice(2, 6).bytes()).to.deep.equal(new Uint8Array([1, 1, 2, 2]))
      expect(pulls).to.equal(2)
    })

    it('cancels the source of a range cancelled at once', async () => {
      const ctx = await setup()
      const cancel = vi.fn()
      const source = new ReadableStream({ cancel })
      ctx.std.fs.mount('mem:', { read: async () => ({ stream: source }) })
      await ctx.std.fs.file('mem://a.txt').slice(1, 2).stream().cancel('reason')
      expect(cancel).toHaveBeenCalledWith('reason')
    })

    it('applies the remaining slices to the range returned by the provider', async () => {
      const ctx = await setup()
      const options: object[] = []
      ctx.std.fs.mount('mem:', {
        capabilities: { range: 'signed' },
        async read(url, value) {
          options.push(value)
          return { stream: new Blob(['0123']).slice(value.start, value.end).stream() }
        },
      })
      expect(await ctx.std.fs.file('mem://a.txt').slice(0, 4).slice(-1).text()).to.equal('3')
      expect(await ctx.std.fs.file('mem://a.txt').slice(-3).slice(0, 2).text()).to.equal('12')
      expect(options).to.deep.equal([{ end: 4 }, { start: -3 }])
    })

    it('keeps only the bytes of a negative slice of a range read by the provider', async () => {
      const ctx = await setup()
      const content = new Uint8Array(1 << 20).fill(1)
      ctx.std.fs.mount('mem:', {
        capabilities: { range: 'signed' },
        read: async (url, { start, end }) => ({ stream: new Blob([content.subarray(start, end)]).stream() }),
      })
      const reader = ctx.std.fs.file('mem://a.bin').slice(0, 1 << 20).slice(-1).stream().getReader()
      const { value } = await reader.read()
      expect(value).to.deep.equal(new Uint8Array([1]))
      expect(value!.buffer.byteLength).to.equal(1)
    })

    it('ends a slice of a range read by the provider at its end', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {
        capabilities: { range: 'signed' },
        read: async url => ({ stream: new ReadableStream({
          start: controller => controller.enqueue(new TextEncoder().encode('a')),
          pull: controller => controller.error(new FsError('Unknown', url, 'Unknown')),
        }) }),
      })
      expect(await ctx.std.fs.file('mem://a.txt').slice(-1000).slice(0, 1).text()).to.equal('a')
    })

    it('emits bytes before EOF when only the end is relative to EOF', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {
        async read() {
          const chunks = ['ab', 'cde']
          return { stream: new ReadableStream({
            pull(controller) {
              const chunk = chunks.shift()
              if (chunk === undefined) throw new Error('read past the required bytes')
              controller.enqueue(new TextEncoder().encode(chunk))
            },
          }, { highWaterMark: 0 }) }
        },
      })
      const file = ctx.std.fs.file('mem://a.txt')
      expect(await file.slice(0, -3).slice(0, 2).text()).to.equal('ab')
    })

    it('preserves pending bytes when a consumer transfers an emitted chunk', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {
        read: async () => ({ stream: new ReadableStream({
          start(controller) {
            for (const chunk of ['abc', 'de', 'fgh']) controller.enqueue(new TextEncoder().encode(chunk))
            controller.close()
          },
        }) }),
      })
      const reader = ctx.std.fs.file('mem://a.txt').slice(0, -3).stream().getReader()
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
        structuredClone(value, { transfer: [value.buffer] })
      }
      expect(text).to.equal('abcde')
    })

    it('ends a range once it is known to be empty, after the first read', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {
        read: async url => ({ stream: new ReadableStream({
          start: controller => controller.enqueue(new Uint8Array(5)),
          pull: controller => controller.error(new FsError('Unknown', url, 'Unknown')),
        }) }),
      })
      for (const [start, end] of [[4, 4], [6, 2], [-2, -2], [-1, 0], [-2, 3]]) {
        expect(await ctx.std.fs.file('mem://a.txt').slice(start, end).text(), `slice(${start}, ${end})`).to.equal('')
      }
      expect(await ctx.std.fs.file('mem://a.txt').slice(1).slice(-2, -2).text()).to.equal('')
    })

    it('cancels the source of a range with a negative bound without `stat`', async () => {
      const ctx = await setup()
      const cancel = vi.fn()
      ctx.std.fs.mount('mem:', {
        read: async () => ({ stream: new ReadableStream({
          async pull(controller) {
            await new Promise(resolve => setTimeout(resolve, 1))
            controller.enqueue(new Uint8Array(4))
          },
          cancel,
        }, { highWaterMark: 0 }) }),
      })
      const reader = ctx.std.fs.file('mem://a.bin').slice(-4).stream().getReader()
      const reading = reader.read()
      await new Promise(resolve => setTimeout(resolve, 10))
      await reader.cancel('reason')
      await reading
      expect(cancel).toHaveBeenCalledWith('reason')
    })

    it('reports a failure of the first read of an empty range', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', {
        read: async url => ({ stream: new ReadableStream({
          pull: controller => controller.error(new FsError('NotFound', url, 'NotFound')),
        }) }),
      })
      expect(await code(ctx.std.fs.file('mem://a.txt').slice(0, 0).text())).to.equal('NotFound')
    })

    it('ends a range without waiting for the cancellation of the source', async () => {
      const ctx = await setup()
      const [branch] = new Blob(['0123456789']).stream().tee()
      ctx.std.fs.mount('mem:', { read: async () => ({ stream: branch }) })
      expect(await ctx.std.fs.file('mem://a.txt').slice(0, 1).text()).to.equal('0')
    })

    it('converts the bounds as `[Clamp] long long`', async () => {
      const ctx = await setup()
      ctx.std.fs.mount('mem:', { read: async () => ({ stream: new Blob(['0123456789']).stream() }) })
      const file = ctx.std.fs.file('mem://a.txt')
      const ranges: [number, number?, string?][] = [
        [0, Infinity, '0123456789'], [Infinity, undefined, ''], [-Infinity, undefined, '0123456789'],
        [NaN, 3, '012'], [1.5, undefined, '23456789'], [2.5, undefined, '23456789'],
        [-1.5, undefined, '89'], [0.5, 3.5, '0123'], [-0.5, undefined, '0123456789'],
      ]
      for (const [start, end, expected] of ranges) {
        expect(await file.slice(start, end).text(), `slice(${start}, ${end})`).to.equal(expected)
      }
    })

    it('rejects a bound that is not a number with a `TypeError`', async () => {
      const ctx = await setup()
      expect(() => ctx.std.fs.file('mem://a.txt').slice('1' as any)).to.throw(TypeError)
    })
  })

  describe('conditional read', () => {
    // a provider of one file of version `v1`, which records its operations
    function versioned(capabilities: FsProvider.Capabilities, stats: Partial<Stats> = {}) {
      const calls: [string, ...unknown[]][] = []
      const provider: FsProvider = {
        capabilities,
        async read(url, options) {
          calls.push(['read', options])
          if (options.ifMatch !== undefined && options.ifMatch !== 'v1') {
            throw new FsError('VersionMismatch', url, 'mismatch')
          }
          return { stream: new Blob(['0123456789']).slice(options.start, options.end).stream() }
        },
        async stat(url, options) {
          calls.push(['stat', options])
          return { type: 'file', size: 10, mtime: new Date(0), version: 'v1', ...stats }
        },
      }
      return { calls, provider }
    }

    it('forwards the version to a provider with `conditional.read`, without `stat()`', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ range: 'signed', conditional: { stat: true, read: true } })
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file('mem://a.txt')
      expect(await file.slice(2, 8).text({ ifMatch: 'v1' })).to.equal('234567')
      expect(await code(file.text({ ifMatch: 'v2' }))).to.equal('VersionMismatch')
      expect(calls).to.deep.equal([
        ['read', { start: 2, end: 8, ifMatch: 'v1' }],
        ['read', { ifMatch: 'v2' }],
      ])
    })

    it('checks the version by `stat()` before a read without the version', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ range: 'signed', conditional: { stat: true } })
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file('mem://a.txt')
      expect(await file.slice(2, 8).text({ ifMatch: 'v1' })).to.equal('234567')
      expect(calls).to.deep.equal([['stat', { follow: true }], ['read', { start: 2, end: 8 }]])
      calls.length = 0
      expect(await code(file.slice(2, 8).text({ ifMatch: 'v2' }))).to.equal('VersionMismatch')
      expect(calls).to.deep.equal([['stat', { follow: true }]])
    })

    it('throws `NotSupported` before any I/O without a way to check the version, also for an empty range', async () => {
      const cases: FsProvider.Capabilities[] = [{}, { range: 'signed' }, { conditional: { write: true } }]
      for (const capabilities of cases) {
        const ctx = await setup()
        const { calls, provider } = versioned(capabilities)
        ctx.std.fs.mount('mem:', provider)
        const file = ctx.std.fs.file('mem://a.txt')
        for (const ref of [file, file.slice(0, 0), file.slice(-2)]) {
          expect(() => ref.stream({ ifMatch: 'v1' })).to.throw(FsError).with.property('code', 'NotSupported')
        }
        expect(await file.text()).to.equal('0123456789')
        expect(calls.filter(([name]) => name === 'stat')).to.deep.equal([])
        expect(calls).to.have.length(1)
      }
    })

    it('does not check a version by `stat()` without the method', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true } })
      delete provider.stat
      ctx.std.fs.mount('mem:', provider)
      expect(() => ctx.std.fs.file('mem://a.txt').stream({ ifMatch: 'v1' })).to.throw(FsError).with.property('code', 'NotSupported')
      expect(calls).to.deep.equal([])
    })

    it('rejects a version that is not a string with a `TypeError`', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true, read: true } })
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file('mem://a.txt')
      expect(() => file.stream({ ifMatch: null as any })).to.throw(TypeError)
      expect(await file.text({ ifMatch: 1 as any }).catch(error => error)).to.be.instanceOf(TypeError)
      expect(calls).to.deep.equal([])
    })

    it('fails on an entry other than a file, also with the same version', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true } }, { type: 'directory' })
      ctx.std.fs.mount('mem:', provider)
      expect(await code(ctx.std.fs.file('mem://a.txt').text({ ifMatch: 'v1' }))).to.equal('VersionMismatch')
      expect(calls.map(([name]) => name)).to.deep.equal(['stat'])
    })

    it('reports a file without a version under `conditional.stat` as a failure of the provider', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true } }, { version: undefined })
      ctx.std.fs.mount('mem:', provider)
      expect(await code(ctx.std.fs.file('mem://a.txt').text({ ifMatch: 'v1' }))).to.equal('Unknown')
      expect(calls.map(([name]) => name)).to.deep.equal(['stat'])
    })

    it('propagates a failure of the check of the version without reading', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ range: 'unsigned', conditional: { stat: true, read: true } })
      provider.stat = async (url) => {
        calls.push(['stat'])
        throw new FsError('PermissionDenied', url, 'denied')
      }
      ctx.std.fs.mount('mem:', provider)
      expect(await code(ctx.std.fs.file('mem://a.txt').slice(-3).text({ ifMatch: 'v1' }))).to.equal('PermissionDenied')
      expect(calls).to.deep.equal([['stat']])
    })

    it('resolves a range by the size of a matching version', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ range: 'unsigned', conditional: { stat: true, read: true } })
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file('mem://a.txt')
      expect(await file.slice(-3).text({ ifMatch: 'v1' })).to.equal('789')
      expect(calls).to.deep.equal([['stat', { follow: true }], ['read', { start: 7, end: 10, ifMatch: 'v1' }]])
      calls.length = 0
      expect(await code(file.slice(-3).text({ ifMatch: 'v2' }))).to.equal('VersionMismatch')
      expect(calls).to.deep.equal([['stat', { follow: true }]])
    })

    it('slices the stream of a matching version whose size cannot resolve a range', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ range: 'unsigned', conditional: { stat: true } }, { size: NaN })
      ctx.std.fs.mount('mem:', provider)
      expect(await ctx.std.fs.file('mem://a.txt').slice(-3).text({ ifMatch: 'v1' })).to.equal('789')
      expect(calls).to.deep.equal([['stat', { follow: true }], ['read', {}]])
    })

    it('does not query a size that is not checked against the version', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ range: 'unsigned', conditional: { read: true } })
      ctx.std.fs.mount('mem:', provider)
      expect(await ctx.std.fs.file('mem://a.txt').slice(2, 8).slice(-2).text({ ifMatch: 'v1' })).to.equal('67')
      expect(calls).to.deep.equal([['read', { start: 2, end: 8, ifMatch: 'v1' }]])
    })

    it('reports a rejected read of the provider through the stream', async () => {
      const ctx = await setup()
      const failure = new FsError('NotFound', new URL('mem://a.txt'), 'missing')
      ctx.std.fs.mount('mem:', { read() { throw failure } })
      const stream = ctx.std.fs.file('mem://a.txt').stream()
      expect(await stream.getReader().read().catch(error => error)).to.equal(failure)
    })

    it('closes the stream with the source once its last chunk is read', async () => {
      const ctx = await setup()
      // a source that closes once its chunks are enqueued
      const source = (chunks: string[]) => new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      })
      ctx.std.fs.mount('mem:', { read: async url => ({ stream: source(url.pathname ? [url.pathname] : []) }) })
      const reader = ctx.std.fs.file('mem:foo').stream().getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).to.equal('foo')
      await reader.closed
      await ctx.std.fs.file('mem:').stream().getReader().closed
    })

    it('cancels a source requested before the stream is cancelled once it is obtained, with the result of its cancellation', async () => {
      const ctx = await setup()
      const opened = Promise.withResolvers<void>()
      const failure = new Error('cleanup failed')
      const cancel = vi.fn(() => Promise.reject(failure))
      ctx.std.fs.mount('mem:', {
        async read() {
          await opened.promise
          return { stream: new ReadableStream({ cancel }) }
        },
      })
      const cancelled = ctx.std.fs.file('mem://a.txt').stream().cancel('reason')
      opened.resolve()
      expect(await cancelled.catch(error => error)).to.equal(failure)
      expect(cancel).toHaveBeenCalledWith('reason')
    })
  })

  describe('conditional write', () => {
    // a provider of files, whose versions are their contents, which records its operations
    function versioned(capabilities: FsProvider.Capabilities, entries: Record<string, string | null> = {}, failures: FsError[] = []) {
      const files = new Map<string, string | null>(Object.entries(entries))
      const calls: [string, ...unknown[]][] = []
      const missing = (url: URL) => new FsError('NotFound', url, 'missing')
      const provider: FsProvider = {
        capabilities: { exclusive: true, ...capabilities },
        async write(url, body, options) {
          calls.push(['write', url.href, options])
          files.set(url.href, await new Response(body).text())
          return { version: 'written' }
        },
        async stat(url, options) {
          calls.push(['stat', url.href, options])
          if (!files.has(url.href)) throw missing(url)
          const content = files.get(url.href)
          if (content === null) return { type: 'symlink', size: 0, mtime: new Date(0) }
          return { type: 'file', size: content!.length, mtime: new Date(0), version: content! }
        },
        async rename(src, dest) {
          calls.push(['rename', src.href, dest.href])
          const failure = failures.shift()
          if (failure) throw failure
          files.set(dest.href, files.get(src.href)!)
          files.delete(src.href)
        },
        async remove(url) {
          calls.push(['remove', url.href])
          if (!files.delete(url.href)) throw missing(url)
        },
      }
      return { files, calls, provider }
    }

    const target = 'mem://vol/a.txt'

    it('forwards the version to a provider with `conditional.write`, with `atomic`', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ atomic: true, conditional: { stat: true, write: true } }, { [target]: 'old' })
      ctx.std.fs.mount('mem:', provider)
      expect(await ctx.std.fs.file(target).write('new', { ifMatch: 'old', atomic: true })).to.deep.equal({ version: 'written' })
      expect(calls).to.deep.equal([['write', target, { exclusive: false, atomic: true, ifMatch: 'old' }]])
    })

    it('checks the version by `stat()` before a direct write without the version', async () => {
      const ctx = await setup()
      const { files, calls, provider } = versioned({ conditional: { stat: true } }, { [target]: 'old' })
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file(target)
      expect(await code(file.write('new', { ifMatch: 'other' }))).to.equal('VersionMismatch')
      expect(await code(ctx.std.fs.file('mem://vol/b.txt').write('new', { ifMatch: 'old' }))).to.equal('VersionMismatch')
      expect(calls.map(([name]) => name)).to.deep.equal(['stat', 'stat'])
      calls.length = 0
      expect(await file.write('new', { ifMatch: 'old' })).to.deep.equal({ version: 'written' })
      expect(calls).to.deep.equal([
        ['stat', target, { follow: true }],
        ['write', target, { exclusive: false, atomic: false }],
      ])
      expect([...files.keys()]).to.deep.equal([target])
    })

    it('treats a `NotFound` thrown by `stat()` as a missing destination', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true } }, { [target]: 'old' })
      provider.stat = (url) => { throw new FsError('NotFound', url, 'missing') }
      ctx.std.fs.mount('mem:', provider)
      for (const atomic of [false, true]) {
        expect(await code(ctx.std.fs.file(target).write('new', { ifMatch: 'old', atomic }))).to.equal('VersionMismatch')
      }
      expect(calls).to.deep.equal([])
    })

    it('fails on an entry other than a file, also with the same version', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true } })
      provider.stat = async () => ({ type: 'directory', size: 0, mtime: new Date(0), version: 'old' })
      ctx.std.fs.mount('mem:', provider)
      expect(await code(ctx.std.fs.file(target).write('new', { ifMatch: 'old' }))).to.equal('VersionMismatch')
      expect(await code(ctx.std.fs.file(target).write('new', { ifMatch: 'old', atomic: true }))).to.equal('VersionMismatch')
      expect(calls).to.deep.equal([])
    })

    it('checks the destination of a composed atomic write before the temporary file and before each rename', async () => {
      const ctx = await setup()
      const { files, calls, provider } = versioned({ conditional: { stat: true, write: true } }, { [target]: 'old' }, [
        new FsError('Busy', new URL(target), 'busy'),
      ])
      ctx.std.fs.mount('mem:', provider)
      const file = ctx.std.fs.file(target)
      expect(await code(file.write('new', { ifMatch: 'other', atomic: true }))).to.equal('VersionMismatch')
      expect(calls.map(([name]) => name)).to.deep.equal(['stat'])
      calls.length = 0
      await file.write('new', { ifMatch: 'old', atomic: true })
      expect(files.get(target)).to.equal('new')
      expect(calls.map(([name, , options]) => name === 'stat' ? `stat ${(options as StatOptions).follow}` : name)).to.deep.equal([
        'stat false', 'write', 'stat false', 'rename', 'stat false', 'rename',
      ])
      // the temporary file is written without the version of the destination
      expect(calls[1][2]).not.to.have.property('ifMatch')
    })

    it('keeps a destination that becomes a link while a composed atomic write waits to retry', async () => {
      const ctx = await setup()
      const { files, calls, provider } = versioned({ conditional: { stat: true } }, { [target]: 'old' }, [
        new FsError('Busy', new URL(target), 'busy'),
      ])
      const rename = provider.rename!
      provider.rename = async (src, dest) => {
        try {
          await rename(src, dest)
        } finally {
          files.set(target, null)
        }
      }
      ctx.std.fs.mount('mem:', provider)
      expect(await code(ctx.std.fs.file(target).write('new', { ifMatch: 'old', atomic: true }))).to.equal('VersionMismatch')
      expect([...files]).to.deep.equal([[target, null]])
      expect(calls.at(-1)?.[0]).to.equal('remove')
    })

    it('rejects a write without a way to check the version, cancelling the stream with the error', async () => {
      const cases: FsProvider.Capabilities[] = [{}, { conditional: { write: true } }]
      for (const capabilities of cases) {
        const ctx = await setup()
        const { calls, provider } = versioned(capabilities, { [target]: 'old' })
        ctx.std.fs.mount('mem:', provider)
        // `conditional.write` serves only a direct write
        const atomic = !!capabilities.conditional
        const cancel = vi.fn()
        const error = await ctx.std.fs.file(target).write(new ReadableStream({ cancel }), { ifMatch: 'old', atomic }).catch(error => error)
        expect(error).to.have.property('code', 'NotSupported')
        expect(cancel).toHaveBeenCalledWith(error)
        expect(calls).to.deep.equal([])
      }
    })

    it('does not check a version by `stat()` without the method', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true } }, { [target]: 'old' })
      delete provider.stat
      ctx.std.fs.mount('mem:', provider)
      for (const atomic of [false, true]) {
        expect(await code(ctx.std.fs.file(target).write('new', { ifMatch: 'old', atomic }))).to.equal('NotSupported')
      }
      expect(calls).to.deep.equal([])
    })

    it('rejects an invalid version, or one with `exclusive`, with a `TypeError` that cancels the stream', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true, write: true } }, { [target]: 'old' })
      ctx.std.fs.mount('mem:', provider)
      for (const options of [{ ifMatch: null as any }, { ifMatch: 'old', exclusive: true }]) {
        const cancel = vi.fn()
        const error = await ctx.std.fs.file(target).write(new ReadableStream({ cancel }), options).catch(error => error)
        expect(error).to.be.instanceOf(TypeError)
        expect(cancel).toHaveBeenCalledWith(error)
      }
      expect(calls).to.deep.equal([])
    })

    it('rejects a copy with a version with a `TypeError` before any I/O', async () => {
      const ctx = await setup()
      const { calls, provider } = versioned({ conditional: { stat: true, write: true } }, { [target]: 'old' })
      ctx.std.fs.mount('mem:', provider)
      const error = await ctx.std.fs.copy(target, 'mem://vol/b.txt', { ifMatch: 'old' } as CopyOptions).catch(error => error)
      expect(error).to.be.instanceOf(TypeError)
      expect(calls).to.deep.equal([])
    })
  })

  it('recognizes an `FsError` from another copy of the package', () => {
    const error = Object.assign(new Error(), { [Symbol.for('cordis.fs.error')]: true })
    expect(error).to.be.instanceOf(FsError)
    expect(new Error()).not.to.be.instanceOf(FsError)
  })
})
