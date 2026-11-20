import { Context, Fiber, FiberState } from 'cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Fs, { BaseFs, DirEntryRef, FileRef, FsError, FsProvider, Watcher } from '../src/index.ts'

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
        expect(() => ctx.fs.mount(prefix, fakeProvider())).to.throw(FsError).with.property('code', 'InvalidPath')
      }
    })

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

    it('forwards the locations of no other mount to the provider mounted at the empty string', async () => {
      const ctx = await setup()
      const fallback = fakeProvider()
      const provider = fakeProvider()
      ctx.fs.mount('', fallback)
      ctx.fs.mount('mem:', provider)

      ctx.fs.watch('mem://bucket/a.txt')
      ctx.fs.watch('file:///a.txt')
      ctx.fs.watch('https://example.com/a.txt')
      expect(provider.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/a.txt'])
      expect(fallback.calls.map(call => call.url.href)).to.deep.equal(['file:///a.txt', 'https://example.com/a.txt'])
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
    it('resolves a path against the base URL', async () => {
      const ctx = await setup('file:///app/')
      expect(ctx.fs.resolve('data/a.txt').href).to.equal('file:///app/data/a.txt')
      expect(ctx.fs.resolve('./data/../a.txt').href).to.equal('file:///app/a.txt')
      expect(ctx.fs.resolve('/a.txt').href).to.equal('file:///a.txt')
      expect(ctx.fs.resolve('data/').href).to.equal('file:///app/data/')
      expect(ctx.fs.resolve('').href).to.equal('file:///app/')
    })

    it('takes every character of a name in a path literally', async () => {
      const ctx = await setup('mem://bucket/')
      expect(ctx.fs.resolve('a#b?c%41 .txt').href).to.equal('mem://bucket/a%23b%3Fc%2541%20.txt')
      expect(ctx.fs.resolve(' a\tb\n').href).to.equal('mem://bucket/%20a%09b%0A')
      // a name that looks like a scheme follows `./`
      expect(ctx.fs.resolve('./ab:c').href).to.equal('mem://bucket/ab:c')
    })

    it('separates the names of a path with `\\`', async () => {
      const ctx = await setup('mem://bucket/')
      expect(ctx.fs.resolve('dir\\a.txt').href).to.equal('mem://bucket/dir/a.txt')
      expect(ctx.fs.resolve('\\a.txt').href).to.equal('mem://bucket/a.txt')
    })

    it('takes a drive letter as the first name of an absolute path, on the local host of a file URL', async () => {
      const ctx = await setup('file://nas/share/app/')
      expect(ctx.fs.resolve('D:\\data\\a.txt').href).to.equal('file:///D:/data/a.txt')
      expect(ctx.fs.resolve('D:/data/').href).to.equal('file:///D:/data/')
      expect(ctx.fs.resolve('/x').href).to.equal('file://nas/x')
      expect((await setup('C:\\app')).fs.baseUrl?.href).to.equal('file:///C:/app/')
    })

    it('takes two leading separators and a host as a path on that host', async () => {
      const ctx = await setup('file:///C:/app/')
      expect(ctx.fs.resolve('\\\\fileserver\\team\\a.txt').href).to.equal('file://fileserver/team/a.txt')
      expect(ctx.fs.resolve('//fileserver/team/').href).to.equal('file://fileserver/team/')
      const memory = await setup('mem://bucket/')
      expect(memory.fs.resolve('//other/a.txt').href).to.equal('mem://other/a.txt')
    })

    it('takes each element of an array as a literal name', async () => {
      const ctx = await setup('mem://bucket/')
      expect(ctx.fs.resolve(['dir', 'a\\b#1.txt']).href).to.equal('mem://bucket/dir/a%5Cb%231.txt')
      expect(ctx.fs.resolve(['a.txt'], new URL('mem://bucket/dir')).href).to.equal('mem://bucket/dir/a.txt')
      for (const names of [[''], ['.'], ['..'], ['a/b']]) {
        expect(() => ctx.fs.resolve(names)).to.throw(FsError).with.property('code', 'InvalidPath')
      }
    })

    // a file URL reads a first segment `C|` as the drive `C:`
    it('keeps the name `C|` in every segment', async () => {
      const ctx = await setup('mem://bucket/')
      expect(decodeURIComponent(ctx.fs.resolve(['C|'], new URL('file:///')).pathname)).to.equal('/C|')
      expect(ctx.fs.resolve('C|/a', new URL('file:///app/')).href).to.equal('file:///app/C|/a')
      expect(ctx.fs.resolve('../C|/a', new URL('file:///D:/')).href).to.equal('file:///D:/C|/a')
      expect(ctx.fs.resolve('C|/a', new URL('mem://bucket/app/')).href).to.equal('mem://bucket/app/C|/a')
    })

    it('rejects a URL that is not a location, and leaves an opaque URL to its provider', async () => {
      const ctx = await setup('mem://bucket/')
      for (const location of ['mem://bucket/a?x', 'mem://bucket/a#x', 'mem://bucket/a%2Fb', 'mem://bucket/100%.txt']) {
        expect(() => ctx.fs.file(location)).to.throw(FsError).with.property('code', 'InvalidPath')
        expect(() => ctx.fs.resolve(new URL(location))).to.throw(FsError).with.property('code', 'InvalidPath')
      }
      expect(ctx.fs.resolve('data:,a#b').href).to.equal('data:,a#b')
    })

    it('takes an absolute URL independently of the base URL', async () => {
      const ctx = await setup('file:///app/')
      expect(ctx.fs.resolve('mem://bucket/a.txt').href).to.equal('mem://bucket/a.txt')
      const url = new URL('mem://bucket/b.txt')
      expect(ctx.fs.resolve(url)).to.equal(url)
    })

    it('resolves a path against the working directory by default', async () => {
      const ctx = await setup()
      expect(ctx.fs.resolve('a.txt').href).to.equal(pathToFileURL(join(process.cwd(), 'a.txt')).href)
    })

    it('takes only absolute URLs as locations without a base URL', async () => {
      const { root } = await startWithoutCwd()
      expect(root.fs.baseUrl).to.be.undefined
      expect(root.fs.resolve('mem://bucket/a.txt').href).to.equal('mem://bucket/a.txt')
      for (const path of ['a.txt', ['a.txt']]) {
        expect(() => root.fs.resolve(path)).to.throw(FsError).with.property('code', 'InvalidPath')
      }
      expect(root.intercept('fs', { baseUrl: 'mem://bucket/' }).fs.resolve('a.txt').href).to.equal('mem://bucket/a.txt')
      expect(() => root.intercept('fs', { baseUrl: 'data/' }).fs.baseUrl).to.throw(TypeError)
    })

    it('fails to start with a path as the base URL on a runtime without a working directory', async () => {
      const { root } = await startWithoutCwd({ baseUrl: 'mem://bucket/' })
      expect(root.fs.resolve('a.txt').href).to.equal('mem://bucket/a.txt')
      const { fiber } = await startWithoutCwd({ baseUrl: 'data/' })
      expect(fiber.state).to.equal(FiberState.FAILED)
    })

    it('does not read the working directory for an absolute base URL', async () => {
      vi.spyOn(process, 'cwd').mockImplementation(() => {
        throw new Error('no working directory')
      })
      try {
        const ctx = await setup('mem://bucket/')
        expect(ctx.fs.baseUrl?.href).to.equal('mem://bucket/')
      } finally {
        vi.restoreAllMocks()
      }
    })

    it('resolves a path of the config against the working directory', async () => {
      const ctx = await setup('data')
      expect(ctx.fs.baseUrl?.href).to.equal(pathToFileURL(join(process.cwd(), 'data')).href + '/')
    })

    it('takes the base URL of the innermost intercept', async () => {
      const ctx = await setup('file:///app/')
      const inner = ctx.intercept('fs', { baseUrl: 'mem://bucket/' }).intercept('fs', { baseUrl: 'file:///data/' })
      expect(inner.fs.resolve('a.txt').href).to.equal('file:///data/a.txt')
      expect(ctx.fs.resolve('a.txt').href).to.equal('file:///app/a.txt')
    })

    it('resolves a relative base URL against the outer one', async () => {
      const ctx = await setup('file:///app/')
      const inner = ctx.intercept('fs', { baseUrl: 'data/' }).intercept('fs', { baseUrl: '../logs/' })
      expect(inner.fs.baseUrl?.href).to.equal('file:///app/logs/')
      expect(inner.fs.resolve('a.txt').href).to.equal('file:///app/logs/a.txt')
    })

    it.each(['mem:bucket', 'mem:bucket/'])('rejects a base URL with an opaque path, such as %s', async (baseUrl) => {
      const root = new Context()
      const fiber = root.plugin(Fs, { baseUrl })
      fibers.push(fiber)
      await fiber.await().catch(() => {})
      expect(fiber.state).to.equal(FiberState.FAILED)
      const ctx = await setup('file:///app/')
      expect(() => ctx.intercept('fs', { baseUrl }).fs.baseUrl).to.throw(TypeError)
    })

    it('takes a base URL as a directory without a query or fragment', async () => {
      const ctx = await setup('file:///app?x#y')
      const inner = ctx.intercept('fs', { baseUrl: 'data' })
      expect(ctx.fs.baseUrl?.href).to.equal('file:///app/')
      expect(inner.fs.baseUrl?.href).to.equal('file:///app/data/')
    })

    it('rejects a base URL that is not a location', async () => {
      const root = new Context()
      const fiber = root.use(Fs, { baseUrl: 'mem://bucket/%2F' })
      fibers.push(fiber)
      await fiber.await().catch(() => {})
      expect(fiber.state).to.equal(FiberState.FAILED)
      const ctx = await setup('mem://bucket/')
      expect(() => ctx.intercept('fs', { baseUrl: 'mem://bucket/100%/' }).fs.baseUrl).to.throw(TypeError)
    })

    it('rejects a URL that cannot be parsed with `InvalidPath`', async () => {
      const ctx = await setup('file:///app/')
      expect(() => ctx.fs.resolve('http://[')).to.throw(FsError).with.property('code', 'InvalidPath')
    })

        it('watches the resolved location', async () => {
      const ctx = await setup('mem://bucket/dir/')
      const provider = fakeProvider()
      ctx.fs.mount('mem:', provider)
      ctx.fs.watch('a.txt')
      expect(provider.calls.map(call => call.url.href)).to.deep.equal(['mem://bucket/dir/a.txt'])
    })
  })

  function recorder() {
    const calls: [string, ...any[]][] = []
    const provider: FsProvider = {
      read(url) { calls.push(['read', url.href]); return new Blob(['foo']).stream() },
      async write(url, body) { calls.push(['write', url.href, await new Response(body).text()]) },
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
      async readlink(url) { calls.push(['readlink', url.href]); return 'a.txt' },
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
      ctx.fs.mount('mem:', provider)

      const file = ctx.fs.file('a.txt')
      expect(file.url.href).to.equal('mem://bucket/dir/a.txt')
      expect(await file.text()).to.equal('foo')
      await file.write('bar')
      await ctx.fs.access('a.txt', 'write')
      await ctx.fs.rename('a.txt', 'b.txt')
      await ctx.fs.remove('b.txt')
      await ctx.fs.remove('b.txt', { recursive: true })
      await ctx.fs.stat('a.txt')
      await ctx.fs.stat('a.txt', { follow: false })
      for await (const _ of ctx.fs.readdir('.')) {}
      await ctx.fs.mkdir('sub')
      await ctx.fs.mkdir('sub', { recursive: true })
      await ctx.fs.symlink('../a.txt', 'link')
      expect(await ctx.fs.readlink('link')).to.equal('a.txt')
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
      expect(await code(ctx.fs.stat('mem://a.txt'))).to.equal('NotSupported')
      expect(await code(ctx.fs.exists('mem://a.txt'))).to.equal('NotSupported')
      expect(await code(ctx.fs.readdir('mem://dir')[Symbol.asyncIterator]().next())).to.equal('NotSupported')
      expect(await code(ctx.fs.mkdir('mem://dir'))).to.equal('NotSupported')
      expect(await code(ctx.fs.copy('mem://a.txt', 'mem://b.txt'))).to.equal('NotSupported')
      expect(await code(ctx.fs.symlink('a.txt', 'mem://link'))).to.equal('NotSupported')
      expect(await code(ctx.fs.readlink('mem://link'))).to.equal('NotSupported')
    })

    it('resolves `exists()` to `false` only for `NotFound` and `NotADirectory`', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        async stat(url) {
          const failure = url.pathname.slice(1) as FsError.Code
          if (failure) throw new FsError(failure, url, failure)
          return { type: 'directory', size: 0, mtime: new Date(0) }
        },
      })
      expect(await ctx.fs.exists('mem:///')).to.be.true
      expect(await ctx.fs.exists('mem:///NotFound')).to.be.false
      expect(await ctx.fs.exists('mem:///NotADirectory')).to.be.false
      expect(await code(ctx.fs.exists('mem:///PermissionDenied'))).to.equal('PermissionDenied')
    })

    it('rejects a link target that is not a string with a `TypeError`', async () => {
      const ctx = await setup()
      const { calls, provider } = recorder()
      ctx.fs.mount('mem:', provider)
      const error = await ctx.fs.symlink(new URL('mem://a.txt') as any, 'mem://link').catch(error => error)
      expect(error).to.be.instanceOf(TypeError)
      expect(calls).to.deep.equal([])
    })
    it('rejects an unknown access mode before forwarding it', async () => {
      const ctx = await setup()
      const { calls, provider } = recorder()
      ctx.fs.mount('mem:', provider)
      const error = await ctx.fs.access('mem://a.txt', 'execute' as any).catch(error => error)
      expect(error).to.be.instanceOf(TypeError)
      expect(calls).to.deep.equal([])
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

  describe('readdir', () => {
    function lister(names: string[]): FsProvider {
      return {
        async* readdir() {
          for (const name of names) yield { name, type: 'file' }
        },
      }
    }

    async function list(ctx: Context, path: string) {
      const urls: string[] = []
      for await (const entry of ctx.fs.readdir(path)) urls.push(entry.url.href)
      return urls
    }

    it('gives the location of each entry below the listed directory', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', lister(['a.txt', 'a:b', 'a b', 'a%b', 'a?b', 'a#b', 'a\\b']))
      expect(await list(ctx, 'mem://bucket/dir')).to.deep.equal([
        'mem://bucket/dir/a.txt',
        'mem://bucket/dir/a:b',
        'mem://bucket/dir/a%20b',
        'mem://bucket/dir/a%25b',
        'mem://bucket/dir/a%3Fb',
        'mem://bucket/dir/a%23b',
        'mem://bucket/dir/a%5Cb',
      ])
      expect(await list(ctx, 'mem://bucket/dir/')).to.deep.equal(await list(ctx, 'mem://bucket/dir'))
    })

    it('decodes the location of an entry to its name', async () => {
      const names = ['a:b', 'a b', 'a%b', 'a?b', 'a#b', 'a\\b', 'é']
      const ctx = await setup()
      ctx.fs.mount('file:', lister(names))
      const decoded: string[] = []
      for await (const { url } of ctx.fs.readdir('file:///dir/')) {
        decoded.push(decodeURIComponent(url.pathname.slice('/dir/'.length)))
      }
      expect(decoded).to.deep.equal(names)
    })

    it('lists a file as a reference to it, and another entry as a reference with its type', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        async* readdir() {
          yield { name: 'a #.txt', type: 'file' }
          yield { name: 'dir', type: 'directory' }
          yield { name: 'link', type: 'symlink' }
        },
        read: () => new Blob(['foo']).stream(),
      })
      const entries: DirEntryRef[] = []
      for await (const entry of ctx.fs.readdir('mem://bucket/')) entries.push(entry)
      expect(entries.map(({ name, type }) => [name, type])).to.deep.equal([['a #.txt', 'file'], ['dir', 'directory'], ['link', 'symlink']])
      const [file, ...others] = entries
      expect(file).to.be.instanceOf(FileRef)
      if (file.type === 'file') expect(await file.text()).to.equal('foo')
      for (const entry of others) expect(entry).not.to.be.instanceOf(FileRef)
    })

    it('throws a failure from the iteration', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        async* readdir(url) {
          throw new FsError('NotFound', url, 'NotFound')
        },
      })
      const iterable = ctx.fs.readdir('mem://bucket/dir')
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
        read(url) {
          calls.push('read ' + find(url))
          return new Blob([entries[find(url)]!]).stream()
        },
        async write(url, body) {
          calls.push('write ' + find(url))
          entries[find(url)] = await new Response(body).text()
        },
        async readlink(url) {
          return links[find(url)]
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
      ctx.fs.mount('mem:', provider)
      await ctx.fs.copy('mem:///src', 'mem:///dest', { recursive: true })
      expect(calls).to.deep.equal(['mkdir /dest', 'copy /src/a.txt /dest/a.txt'])
    })

    it('copies a file between two mounts through a read and a write', async () => {
      const ctx = await setup()
      const source = tree({ '/a.txt': 'foo' }, { copy: true })
      const target = tree({}, { copy: true })
      ctx.fs.mount('mem:', source.provider)
      ctx.fs.mount('other:', target.provider)
      await ctx.fs.copy('mem:///a.txt', 'other:///b.txt')
      expect(target.entries['/b.txt']).to.equal('foo')
      expect([...source.calls, ...target.calls]).to.deep.equal(['read /a.txt', 'write /b.txt'])
    })

    it('does not write the destination when the source cannot be read', async () => {
      const ctx = await setup()
      const target = tree({})
      ctx.fs.mount('mem:', {
        async stat() { return { type: 'file', size: 0, mtime: new Date(0) } },
        read(url) {
          return new ReadableStream({
            start() { throw new FsError('PermissionDenied', url, 'PermissionDenied') },
          })
        },
      })
      ctx.fs.mount('other:', target.provider)
      expect(await code(ctx.fs.copy('mem:///a.txt', 'other:///b.txt'))).to.equal('PermissionDenied')
      expect(target.calls).to.deep.equal([])
    })

    it('does not open the source for a destination that cannot be written', async () => {
      const ctx = await setup()
      const source = tree({ '/a.txt': 'foo' })
      const { write: _, ...target } = tree({}).provider
      ctx.fs.mount('mem:', source.provider)
      ctx.fs.mount('other:', target)
      expect(await code(ctx.fs.copy('mem:///a.txt', 'other:///b.txt'))).to.equal('NotSupported')
      expect(source.calls).to.deep.equal([])
    })

    it('fails to copy a link to a provider without links before any change', async () => {
      const ctx = await setup()
      const source = tree({ '/src': null, '/src/a.txt': 'foo' }, { symlink: true })
      source.links['/src/link'] = 'a.txt'
      source.links['/link'] = 'src'
      const target = tree({ '/link': 'bar' })
      ctx.fs.mount('mem:', source.provider)
      ctx.fs.mount('other:', target.provider)
      expect(await code(ctx.fs.copy('mem:///link', 'other:///link'))).to.equal('NotSupported')
      expect(target.entries['/link']).to.equal('bar')
      await ctx.fs.copy('mem:///src', 'mem:///dest', { recursive: true })
      expect(source.links['/dest/link']).to.equal('a.txt')
    })

    it('fails on a destination at or below the source before any I/O', async () => {
      const ctx = await setup()
      const { calls, provider } = recorder()
      ctx.fs.mount('mem:', provider)
      for (const [src, dest] of [
        ['mem://bucket/dir', 'mem://bucket/dir/sub'],
        ['mem://bucket/dir/', 'mem://bucket/dir'],
        ['mem://bucket/a.txt', 'mem://bucket/a.txt'],
        ['mem://bucket/', 'mem://bucket/a.txt'],
      ]) {
        expect(await code(ctx.fs.copy(src, dest, { recursive: true }))).to.equal('InvalidPath')
      }
      expect(calls).to.deep.equal([])
      await ctx.fs.copy('mem://bucket/dir', 'mem://bucket/dir2')
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

    it('keeps each chunk read when the provider reuses its memory', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        read() {
          const chunk = new Uint8Array(1)
          const values = [...'ABC']
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!values.length) return controller.close()
              chunk[0] = values.shift()!.charCodeAt(0)
              controller.enqueue(chunk)
            },
          }, { highWaterMark: 0 })
        },
      })
      expect(await ctx.fs.file('mem://a.txt').text()).to.equal('ABC')
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

    it('rejects a write of a slice, also of the whole content', async () => {
      const ctx = await setup()
      const { written, provider } = memory(new Uint8Array(), 1)
      ctx.fs.mount('mem:', provider)
      const file = ctx.fs.file('mem://a.txt')
      for (const slice of [file.slice(), file.slice(0), file.slice(1)]) {
        expect(await slice.write('foo').catch(error => error)).to.be.instanceOf(TypeError)
      }
      expect(written).to.deep.equal([])
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

  it('does not call a queued ready listener after the watch ends', async () => {
    const ctx = await setup()
    const provider = fakeProvider()
    ctx.fs.mount('mem:', provider)
    const watcher = ctx.fs.watch('mem://a.txt')
    const ready = vi.fn()
    watcher.emit('ready')
    watcher.on('ready', ready)

    await watcher.dispose()
    await new Promise(resolve => setImmediate(resolve))
    expect(ready).not.toHaveBeenCalled()
  })

  describe('provider ranges', () => {
    // a provider of one file, which records the options of its reads
    function single(capabilities: FsProvider.Capabilities) {
      const options: object[] = []
      const provider: FsProvider = {
        capabilities,
        read(url, value) {
          options.push(value)
          return new Blob(['0123456789']).slice(value.start, value.end).stream()
        },
      }
      return { options, provider }
    }

    it.each(['unsigned', 'signed'] as const)('forwards supported bounds without stat (%s)', async (range) => {
      const ctx = await setup()
      const { options, provider } = single({ range })
      const stat = vi.fn(async () => ({ type: 'file' as const, size: 10, mtime: new Date(0) }))
      ctx.fs.mount('mem:', { ...provider, stat })
      const file = ctx.fs.file('mem://a.txt')
      const start = range === 'signed' ? -3 : 3
      await file.text()
      await file.slice(start, 8).text()
      expect(options).to.deep.equal([{}, { start, end: 8 }])
      expect(stat).not.toHaveBeenCalled()
    })

    it.each(['unsigned', 'signed'] as const)('resolves a slice chain to one range using the file size (%s)', async (range) => {
      const ctx = await setup()
      const { options, provider } = single({ range })
      ctx.fs.mount('mem:', {
        ...provider,
        stat: async () => ({ type: 'file', size: 10, mtime: new Date(0) }),
      })
      const file = ctx.fs.file('mem://a.txt')
      expect(await file.slice(1).slice(-1).text()).to.equal('9')
      expect(await file.slice(7, 20).slice(-2, -1).text()).to.equal('8')
      expect(options).to.deep.equal([{ start: 9, end: 10 }, { start: 8, end: 9 }])
    })

    it('resolves a single negative bound for an unsigned provider', async () => {
      const ctx = await setup()
      const { options, provider } = single({ range: 'unsigned' })
      ctx.fs.mount('mem:', {
        ...provider,
        stat: async () => ({ type: 'file', size: 10, mtime: new Date(0) }),
      })
      expect(await ctx.fs.file('mem://a.txt').slice(-3, 9).text()).to.equal('78')
      expect(options).to.deep.equal([{ start: 7, end: 9 }])
    })

    it('merges a slice into the preceding one where the two select the range of one slice', async () => {
      const ctx = await setup()
      const { options, provider } = single({ range: 'signed' })
      ctx.fs.mount('mem:', provider)
      const file = ctx.fs.file('mem://a.txt')
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
      ctx.fs.mount('mem:', { ...provider, stat })
      expect(await ctx.fs.file('mem://a.txt').slice(-3, 9).text()).to.equal('78')
      expect(options).to.deep.equal([{}])
      expect(stat).not.toHaveBeenCalled()
    })

    it.each(['unsigned', 'signed'] as const)('uses only supported bounds when stat fails (%s)', async (range) => {
      const ctx = await setup()
      const { options, provider } = single({ range })
      ctx.fs.mount('mem:', {
        ...provider,
        async stat() { throw new Error('metadata unavailable') },
      })
      const file = ctx.fs.file('mem://a.txt')
      expect(await file.slice(-3).slice(1, 2).text()).to.equal('8')
      expect(await file.slice(1).slice(-1).text()).to.equal('9')
      expect(options).to.deep.equal([range === 'signed' ? { start: -3 } : {}, { start: 1 }])
    })

    it('propagates a read error after an unsuccessful stat', async () => {
      const ctx = await setup()
      const failure = new Error('open failed')
      ctx.fs.mount('mem:', {
        capabilities: { range: 'unsigned' },
        async stat() { throw new Error('metadata unavailable') },
        read: () => new ReadableStream({ start: controller => controller.error(failure) }),
      })
      const reader = ctx.fs.file('mem://a.txt').slice(1).slice(-1).stream().getReader()
      expect(await reader.read().catch(error => error)).to.equal(failure)
    })

    it('leaves the source unopened when cancelled during stat', async () => {
      const ctx = await setup()
      const { options, provider } = single({ range: 'unsigned' })
      const pending = Promise.withResolvers<void>()
      ctx.fs.mount('mem:', {
        ...provider,
        async stat() {
          await pending.promise
          return { type: 'file', size: 10, mtime: new Date(0) }
        },
      })
      const reader = ctx.fs.file('mem://a.txt').slice(-1).stream().getReader()
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
      ctx.fs.mount('mem:', { read: () => new Blob(['0123456789']).stream() })
      const file = ctx.fs.file('mem://a.txt')
      expect(await file.slice(-3).text()).to.equal('789')
      expect(await file.slice(2, -2).slice(-3, -1).text()).to.equal('56')
      expect(await file.slice(2, 5).text()).to.equal('234')
    })

    it('counts bytes beyond an absolute end when the start is relative to EOF', async () => {
      const ctx = await setup()
      let content = ''
      ctx.fs.mount('mem:', {
        read: () => new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(content)
            for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3))
            controller.close()
          },
        }),
      })
      const file = ctx.fs.file('mem://a.txt')
      for (const input of ['a', 'abcd', 'abcde', 'abcdef', 'abcdefgh']) {
        content = input
        for (const [start, end] of [[-4, 2], [-2, 5]]) {
          const bytes = await file.slice(start, end).arrayBuffer()
          expect(new TextDecoder().decode(bytes)).to.equal(content.slice(start, end))
        }
      }
    })

    it('emits stable chunks when the provider reuses its buffer on the next read', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        read() {
          const buffer = new Uint8Array(2)
          let chunk = 0
          return new ReadableStream({
            pull(controller) {
              if (chunk === 4) return controller.close()
              buffer.fill(++chunk)
              controller.enqueue(buffer)
            },
          }, { highWaterMark: 0 })
        },
      })
      const file = ctx.fs.file('mem://a.bin')
      const content = Uint8Array.of(1, 1, 2, 2, 3, 3, 4, 4)
      for (const end of [undefined, 6, -1]) {
        const response = new Response(file.slice(1, end).stream())
        expect(new Uint8Array(await response.arrayBuffer())).to.deep.equal(content.slice(1, end))
      }
    })

    it('keeps the content of a provider that reuses the memory of its chunks', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        read() {
          const buffer = new Uint8Array(1)
          let count = 0
          return new ReadableStream({
            pull(controller) {
              if (count === 3) return controller.close()
              buffer[0] = ++count
              controller.enqueue(buffer)
            },
          }, { highWaterMark: 0 })
        },
      })
      expect(await ctx.fs.file('mem://a.bin').slice(-2).bytes()).to.deep.equal(new Uint8Array([2, 3]))
    })

    it('stops reading the source at the end of a range', async () => {
      const ctx = await setup()
      let pulls = 0
      ctx.fs.mount('mem:', {
        read: () => new ReadableStream({
          pull(controller) {
            pulls++
            controller.enqueue(new Uint8Array(4).fill(pulls))
          },
        }, { highWaterMark: 0 }),
      })
      expect(await ctx.fs.file('mem://a.bin').slice(2, 6).bytes()).to.deep.equal(new Uint8Array([1, 1, 2, 2]))
      expect(pulls).to.equal(2)
    })

    it('cancels the source of a range cancelled at once', async () => {
      const ctx = await setup()
      const cancel = vi.fn()
      const source = new ReadableStream({ cancel })
      ctx.fs.mount('mem:', { read: () => source })
      await ctx.fs.file('mem://a.txt').slice(1, 2).stream().cancel('reason')
      expect(cancel).toHaveBeenCalledWith('reason')
    })

    it('applies the remaining slices to the range returned by the provider', async () => {
      const ctx = await setup()
      const options: object[] = []
      ctx.fs.mount('mem:', {
        capabilities: { range: 'signed' },
        read(url, value) {
          options.push(value)
          return new Blob(['0123']).slice(value.start, value.end).stream()
        },
      })
      expect(await ctx.fs.file('mem://a.txt').slice(0, 4).slice(-1).text()).to.equal('3')
      expect(await ctx.fs.file('mem://a.txt').slice(-3).slice(0, 2).text()).to.equal('12')
      expect(options).to.deep.equal([{ end: 4 }, { start: -3 }])
    })

    it('keeps only the bytes of a negative slice of a range read by the provider', async () => {
      const ctx = await setup()
      const content = new Uint8Array(1 << 20).fill(1)
      ctx.fs.mount('mem:', {
        capabilities: { range: 'signed' },
        read: (url, { start, end }) => new Blob([content.subarray(start, end)]).stream(),
      })
      const reader = ctx.fs.file('mem://a.bin').slice(0, 1 << 20).slice(-1).stream().getReader()
      const { value } = await reader.read()
      expect(value).to.deep.equal(new Uint8Array([1]))
      expect(value!.buffer.byteLength).to.equal(1)
    })

    it('ends a slice of a range read by the provider at its end', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        capabilities: { range: 'signed' },
        read: url => new ReadableStream({
          start: controller => controller.enqueue(new TextEncoder().encode('a')),
          pull: controller => controller.error(new FsError('Unknown', url, 'Unknown')),
        }),
      })
      expect(await ctx.fs.file('mem://a.txt').slice(-1000).slice(0, 1).text()).to.equal('a')
    })

    it('emits bytes before EOF when only the end is relative to EOF', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        read() {
          const chunks = ['ab', 'cde']
          return new ReadableStream({
            pull(controller) {
              const chunk = chunks.shift()
              if (chunk === undefined) throw new Error('read past the required bytes')
              controller.enqueue(new TextEncoder().encode(chunk))
            },
          }, { highWaterMark: 0 })
        },
      })
      const file = ctx.fs.file('mem://a.txt')
      expect(await file.slice(0, -3).slice(0, 2).text()).to.equal('ab')
    })

    it('preserves pending bytes when a consumer transfers an emitted chunk', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        read: () => new ReadableStream({
          start(controller) {
            for (const chunk of ['abc', 'de', 'fgh']) controller.enqueue(new TextEncoder().encode(chunk))
            controller.close()
          },
        }),
      })
      const reader = ctx.fs.file('mem://a.txt').slice(0, -3).stream().getReader()
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
        structuredClone(value, { transfer: [value.buffer] })
      }
      expect(text).to.equal('abcde')
    })

    it('keeps the last chunk of a range when the source is cancelled', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        read() {
          const buffer = Buffer.from('abc')
          return new ReadableStream({
            pull: controller => controller.enqueue(buffer),
            cancel: () => void buffer.fill(0),
          }, { highWaterMark: 0 })
        },
      })
      expect(await ctx.fs.file('mem://a.txt').slice(0, 2).text()).to.equal('ab')
    })

    it('ends a range once it is known to be empty, after the first read', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        read: url => new ReadableStream({
          start: controller => controller.enqueue(new Uint8Array(5)),
          pull: controller => controller.error(new FsError('Unknown', url, 'Unknown')),
        }),
      })
      for (const [start, end] of [[4, 4], [6, 2], [-2, -2], [-1, 0], [-2, 3]]) {
        expect(await ctx.fs.file('mem://a.txt').slice(start, end).text(), `slice(${start}, ${end})`).to.equal('')
      }
      expect(await ctx.fs.file('mem://a.txt').slice(1).slice(-2, -2).text()).to.equal('')
    })

    it('cancels the source of a range with a negative bound without `stat`', async () => {
      const ctx = await setup()
      const cancel = vi.fn()
      ctx.fs.mount('mem:', {
        read: () => new ReadableStream({
          async pull(controller) {
            await new Promise(resolve => setTimeout(resolve, 1))
            controller.enqueue(new Uint8Array(4))
          },
          cancel,
        }, { highWaterMark: 0 }),
      })
      const reader = ctx.fs.file('mem://a.bin').slice(-4).stream().getReader()
      const reading = reader.read()
      await new Promise(resolve => setTimeout(resolve, 10))
      await reader.cancel('reason')
      await reading
      expect(cancel).toHaveBeenCalledWith('reason')
    })

    it('reports a failure of the first read of an empty range', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', {
        read: url => new ReadableStream({
          pull: controller => controller.error(new FsError('NotFound', url, 'NotFound')),
        }),
      })
      expect(await code(ctx.fs.file('mem://a.txt').slice(0, 0).text())).to.equal('NotFound')
    })

    it('ends a range without waiting for the cancellation of the source', async () => {
      const ctx = await setup()
      const [branch] = new Blob(['0123456789']).stream().tee()
      ctx.fs.mount('mem:', { read: () => branch })
      expect(await ctx.fs.file('mem://a.txt').slice(0, 1).text()).to.equal('0')
    })

    it('converts the bounds as `[Clamp] long long`', async () => {
      const ctx = await setup()
      ctx.fs.mount('mem:', { read: () => new Blob(['0123456789']).stream() })
      const file = ctx.fs.file('mem://a.txt')
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
      expect(() => ctx.fs.file('mem://a.txt').slice('1' as any)).to.throw(TypeError)
    })
  })

  it('recognizes an `FsError` from another copy of the package', () => {
    const error = Object.assign(new Error(), { [Symbol.for('cordis.fs.error')]: true })
    expect(error).to.be.instanceOf(FsError)
    expect(new Error()).not.to.be.instanceOf(FsError)
  })
})
