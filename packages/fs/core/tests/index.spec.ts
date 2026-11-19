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
    it('resolves a relative reference against the base URL', async () => {
      const ctx = await setup('file:///app/')
      expect(ctx.fs.resolve('data/a.txt').href).to.equal('file:///app/data/a.txt')
      expect(ctx.fs.resolve('/a.txt').href).to.equal('file:///a.txt')
    })

    it('takes an absolute URL independently of the base URL', async () => {
      const ctx = await setup('file:///app/')
      expect(ctx.fs.resolve('mem://bucket/a.txt').href).to.equal('mem://bucket/a.txt')
      const url = new URL('mem://bucket/b.txt')
      expect(ctx.fs.resolve(url)).to.equal(url)
    })

    it('resolves a relative reference against the working directory by default', async () => {
      const ctx = await setup()
      expect(ctx.fs.resolve('a.txt').href).to.equal(pathToFileURL(join(process.cwd(), 'a.txt')).href)
    })

    it('requires a base URL on a runtime without a working directory', async () => {
      const { fiber } = await startWithoutCwd()
      expect(fiber.state).to.equal(FiberState.FAILED)
      const { root } = await startWithoutCwd({ baseUrl: 'mem://bucket/' })
      expect(root.fs.resolve('a.txt').href).to.equal('mem://bucket/a.txt')
    })

    it('rejects a relative base URL of the config', async () => {
      const root = new Context()
      const fiber = root.plugin(Fs, { baseUrl: 'data/' })
      fibers.push(fiber)
      await fiber.await().catch(() => {})
      expect(fiber.state).to.equal(FiberState.FAILED)
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
      expect(inner.fs.baseUrl.href).to.equal('file:///app/logs/')
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
      const ctx = await setup('file:///app?x')
      const inner = ctx.intercept('fs', { baseUrl: 'data' }).intercept('fs', { baseUrl: 'logs?x#y' })
      expect(ctx.fs.baseUrl.href).to.equal('file:///app/')
      expect(inner.fs.baseUrl.href).to.equal('file:///app/data/logs/')
    })

    it.runIf(process.platform === 'win32')('takes a drive-letter path as a file path', async () => {
      const ctx = await setup('C:\\app')
      expect(ctx.fs.baseUrl.href).to.equal('file:///C:/app/')
      expect(ctx.fs.resolve('D:\\data\\a.txt').href).to.equal('file:///D:/data/a.txt')
      expect(ctx.intercept('fs', { baseUrl: 'D:/data' }).fs.baseUrl.href).to.equal('file:///D:/data/')
    })

    it('rejects a reference that cannot be parsed with `InvalidPath`', async () => {
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

  it('recognizes an `FsError` from another copy of the package', () => {
    const error = Object.assign(new Error(), { [Symbol.for('cordis.fs.error')]: true })
    expect(error).to.be.instanceOf(FsError)
    expect(new Error()).not.to.be.instanceOf(FsError)
  })
})
