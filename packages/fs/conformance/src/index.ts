import Fs, { DirEntryRef, EntryType, FsError, WriteOptions } from '@cordisjs/fs'
import { Context, Fiber } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

export interface ConformanceOptions {
  /** mounts the provider under test, and returns the base URL of an empty directory to work in */
  setup(ctx: Context): Promise<URL>
  /** optional cleanup after each test */
  teardown?(): Promise<void>
  /** whether the provider uses the native Windows file system */
  windows?: boolean
  capabilities?: Capabilities
  /**
   * Returns the current version of the file at `url`, which the tests of
   * conditional reads and writes compare. `Stats.version` by default, for a
   * provider whose `stat()` reports versions.
   */
  version?(ctx: Context, url: URL): Promise<string>
}

export interface Capabilities {
  /** whether the provider supports symbolic links; without them, `symlink()` and `readlink()` fail with `NotSupported` */
  symlink?: boolean
  /** whether the provider declares the capability `exclusive` */
  exclusive?: boolean
  /** whether a file can be written atomically, by the provider or composed by `@cordisjs/fs` */
  atomic?: boolean
  /**
   * The conditional operations, by the provider or composed by
   * `@cordisjs/fs`. Each test changes the size of a file, so that an
   * approximate version also changes.
   *
   * - `stat`: `stat()` reports the version of a file.
   * - `read`: a read checks `ifMatch`.
   * - `write`: a write without `atomic` checks `ifMatch`.
   * - `atomicWrite`: a write with `atomic` checks `ifMatch`. A provider with
   *   the capability `conditional.write` and without `atomic` supports it
   *   only where `stat()` reports versions.
   */
  conditional?: {
    stat?: boolean
    read?: boolean
    write?: boolean
    atomicWrite?: boolean
  }
}

async function rejects(promise: Promise<unknown>, ...codes: FsError.Code[]) {
  const error = await promise.then(() => undefined, error => error)
  expect(error).to.be.instanceOf(FsError)
  expect(error.code).to.be.oneOf(codes)
  return error as FsError
}

/**
 * Define the test suites of the semantics that every provider shares. Each
 * test runs in a new context with the `fs` service, in which `setup()` mounts
 * the provider under test.
 */
export function conformance(name: string, options: ConformanceOptions) {
  const symlinks = !!options.capabilities?.symlink
  const exclusive = !!options.capabilities?.exclusive
  const atomic = !!options.capabilities?.atomic
  const conditional = options.capabilities?.conditional ?? {}
  const windows = options.windows
  // Windows may report a missing path when an intermediate component is a file.
  const belowFile: FsError.Code[] = windows ? ['NotADirectory', 'NotFound'] : ['NotADirectory']

  describe(name, () => {
    let fiber: Fiber | undefined
    let ctx: Context
    let base: URL

    beforeEach(async () => {
      ctx = new Context()
      fiber = await ctx.use(Fs)
      base = await options.setup(ctx)
    })

    afterEach(async () => {
      await fiber?.dispose()
      fiber = undefined
      await options.teardown?.()
    })

    // the location of a reference relative to the working directory
    function url(path: string) {
      return new URL(path, base)
    }

    // writes a file, creating its parent directories
    async function write(path: string, content: string | Uint8Array<ArrayBuffer> = '') {
      await ctx.fs.mkdir(new URL('.', url(path)), { recursive: true })
      await ctx.fs.file(url(path)).write(content)
    }

    function text(path: string) {
      return ctx.fs.file(url(path)).text()
    }

    async function list(path: string) {
      const entries: DirEntryRef[] = []
      for await (const entry of ctx.fs.readdir(url(path))) entries.push(entry)
      return entries
    }

    // the names and the types of the entries of a directory, sorted by name
    async function names(path: string) {
      const entries = await list(path)
      return entries
        .map(({ name, type }) => [name, type] as [string, EntryType])
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    }

    describe('file', () => {
      it('reads the current content', async () => {
        await write('a.txt', 'foo')
        expect(await text('a.txt')).to.equal('foo')
        await write('a.txt', 'bar')
        expect(await text('a.txt')).to.equal('bar')
      })

      it('reads and writes a content of several chunks', async () => {
        const content = new Uint8Array(200 * 1024).map((_, index) => index % 251)
        await write('a.bin', content)
        expect(await ctx.fs.file(url('a.bin')).bytes()).to.deep.equal(content)

        await ctx.fs.file(url('b.bin')).write(ctx.fs.file(url('a.bin')).stream())
        expect(await ctx.fs.file(url('b.bin')).bytes()).to.deep.equal(content)
      })

      it.runIf(exclusive)('allows one exclusive creator across write and copy', async () => {
        await write('src', 'copy')
        const dest = ctx.fs.file(url('dest'))
        const results = await Promise.allSettled([
          dest.write('write', { exclusive: true }),
          ctx.fs.copy(url('src'), dest.url, { exclusive: true }),
        ])
        const winner = results.findIndex(result => result.status === 'fulfilled')
        expect(winner).to.be.oneOf([0, 1])
        expect(results[1 - winner]).to.have.nested.property('reason.code', 'AlreadyExists')
        expect(await dest.text()).to.equal(['write', 'copy'][winner])
      })

      it('does not create the parent directory', async () => {
        await rejects(ctx.fs.file(url('missing/a.txt')).write('foo'), 'NotFound')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('rejects a write with the error of the stream', async () => {
        const error = new Error('aborted')
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('foo'))
            controller.error(error)
          },
        })
        expect(await ctx.fs.file(url('a.txt')).write(body).catch(error => error)).to.equal(error)
      })

      it('fails to read a missing file with the location', async () => {
        const file = ctx.fs.file(url('missing.txt'))
        const error = await rejects(file.text(), 'NotFound')
        expect(error.url?.href).to.equal(file.url.href)
      })

      it('fails to read or write a directory', async () => {
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.file(url('dir')).text(), 'IsADirectory')
        await rejects(ctx.fs.file(url('dir')).write('foo'), 'IsADirectory')
      })

      it('fails to read or write a location named with a trailing separator', async () => {
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.file(url('dir/')).text(), 'IsADirectory')
        await rejects(ctx.fs.file(url('missing/')).write('foo'), 'IsADirectory')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('fails to read below a file', async () => {
        await write('a.txt')
        await rejects(ctx.fs.file(url('a.txt/b.txt')).text(), ...belowFile)
      })
    })

    describe.runIf(atomic)('atomic write', () => {
      function atomic(path: string, data: string | ReadableStream<Uint8Array>) {
        return ctx.fs.file(url(path)).write(data, { atomic: true })
      }

      it('replaces the content of a file, and creates a missing one', async () => {
        await write('a.txt', 'foo')
        await atomic('a.txt', 'bar')
        await atomic('b.txt', 'baz')
        expect(await text('a.txt')).to.equal('bar')
        expect(await text('b.txt')).to.equal('baz')
        expect(await names('')).to.deep.equal([['a.txt', 'file'], ['b.txt', 'file']])
      })

      it('keeps the previous content readable until the stream ends', async () => {
        await write('a', 'old')
        const consumed = Promise.withResolvers<void>()
        const finish = Promise.withResolvers<void>()
        let first = true
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (first) {
              first = false
              controller.enqueue(new Uint8Array([65]))
            } else {
              consumed.resolve()
              await finish.promise
              controller.enqueue(new Uint8Array([66]))
              controller.close()
            }
          },
        }, { highWaterMark: 0 })
        const pending = atomic('a', body)
        try {
          await consumed.promise
          expect(await text('a')).to.equal('old')
        } finally {
          finish.resolve()
          await pending
        }
        expect(await text('a')).to.equal('AB')
      })

      it('keeps the previous content and no temporary file when the stream errors', async () => {
        await write('a.txt', 'foo')
        const error = new Error('aborted')
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('bar'))
            controller.error(error)
          },
        })
        expect(await atomic('a.txt', body).catch(error => error)).to.equal(error)
        expect(await text('a.txt')).to.equal('foo')
        expect(await names('')).to.deep.equal([['a.txt', 'file']])
      })

      it('atomically copies a file and rejects a directory before changing the destination', async () => {
        await write('src/a', 'new')
        await write('dest/a', 'old')
        await rejects(ctx.fs.copy(url('src'), url('dest'), { recursive: true, atomic: true }), 'NotSupported')
        expect(await text('dest/a')).to.equal('old')
        await ctx.fs.copy(url('src/a'), url('dest/a'), { atomic: true })
        expect(await text('dest/a')).to.equal('new')
      })

      it.runIf(symlinks && !windows)('atomically copies the file a link points to only when dereferencing', async () => {
        await write('a', 'data')
        await ctx.fs.symlink('a', url('link'))
        await rejects(ctx.fs.copy(url('link'), url('b'), { atomic: true }), 'NotSupported')
        expect(await ctx.fs.exists(url('b'))).to.equal(false)
        await ctx.fs.copy(url('link'), url('b'), { dereference: true, atomic: true })
        expect(await ctx.fs.file(url('b')).text()).to.equal('data')
      })

      it('does not create the parent directory', async () => {
        await rejects(atomic('missing/a.txt', 'foo'), 'NotFound')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('fails to write a directory or a location named with a trailing separator', async () => {
        await ctx.fs.mkdir(url('dir'))
        await rejects(atomic('dir', 'foo'), 'IsADirectory')
        await rejects(atomic('missing/', 'foo'), 'IsADirectory')
        expect(await names('')).to.deep.equal([['dir', 'directory']])
      })

      it.runIf(symlinks)('writes through symbolic links in the last component, also a dangling one', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('dir/a.txt', url('link.txt'))
        await ctx.fs.symlink('link.txt', url('chain.txt'))
        await ctx.fs.symlink('dir/new.txt', url('dangling.txt'))
        await atomic('chain.txt', 'bar')
        await atomic('dangling.txt', 'baz')
        expect(await text('dir/a.txt')).to.equal('bar')
        expect(await text('dir/new.txt')).to.equal('baz')
        expect((await ctx.fs.stat(url('link.txt'), { follow: false })).type).to.equal('symlink')
        expect(await names('dir')).to.deep.equal([['a.txt', 'file'], ['new.txt', 'file']])
      })
    })

    describe.runIf(Object.values(conditional).some(Boolean))('conditional', () => {
      async function version(path: string) {
        if (options.version) return options.version(ctx, url(path))
        const { version } = await ctx.fs.stat(url(path))
        expect(version).to.be.a('string')
        return version!
      }

      // the variants of a write that check a version
      const writes: WriteOptions[] = [
        ...conditional.write ? [{}] : [],
        ...conditional.atomicWrite ? [{ atomic: true }] : [],
      ]

      it.runIf(conditional.stat)('reports the version of a file, which changes with its content', async () => {
        await write('a.txt', 'foo')
        const { version: before } = await ctx.fs.stat(url('a.txt'))
        expect(before).to.be.a('string')
        expect((await ctx.fs.stat(url('a.txt'))).version).to.equal(before)
        await write('a.txt', 'foobar')
        expect((await ctx.fs.stat(url('a.txt'))).version).not.to.equal(before)
      })

      it.runIf(conditional.read)('reads a file, also a slice, of the version', async () => {
        await write('a.txt', '0123456789')
        const file = ctx.fs.file(url('a.txt'))
        const current = await version('a.txt')
        expect(await file.text({ ifMatch: current })).to.equal('0123456789')
        expect(await file.slice(2, 8).text({ ifMatch: current })).to.equal('234567')
        expect(await file.slice(-3).text({ ifMatch: current })).to.equal('789')
        expect(await file.slice(2, 8).slice(-2).text({ ifMatch: current })).to.equal('67')
      })

      it.runIf(conditional.read)('fails to read another version before any byte, also of a slice', async () => {
        await write('a.txt', 'foo')
        const previous = await version('a.txt')
        await write('a.txt', 'foobar')
        const file = ctx.fs.file(url('a.txt'))
        for (const ref of [file, file.slice(1, 2), file.slice(-2), file.slice(0, 0)]) {
          await rejects(ref.stream({ ifMatch: previous }).getReader().read(), 'VersionMismatch')
        }
      })

      it.runIf(conditional.read)('fails to read a directory or a missing file with a version', async () => {
        await write('a.txt', 'foo')
        const current = await version('a.txt')
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.file(url('dir')).text({ ifMatch: current }), 'VersionMismatch')
        await rejects(ctx.fs.file(url('missing.txt')).text({ ifMatch: current }), 'NotFound', 'VersionMismatch')
      })

      it.runIf(writes.length > 0)('replaces a file of the version', async () => {
        for (const options of writes) {
          await write('a.txt', 'foo')
          const result = await ctx.fs.file(url('a.txt')).write('foobar', { ...options, ifMatch: await version('a.txt') })
          expect(await text('a.txt')).to.equal('foobar')
          // a version of the result identifies the same content as other versions
          if (result.version !== undefined) expect(await version('a.txt')).to.equal(result.version)
        }
      })

      it.runIf(writes.length > 0)('keeps a file of another version', async () => {
        for (const options of writes) {
          await write('a.txt', 'foo')
          const previous = await version('a.txt')
          await write('a.txt', 'foobar')
          await rejects(ctx.fs.file(url('a.txt')).write('baz', { ...options, ifMatch: previous }), 'VersionMismatch')
          expect(await text('a.txt')).to.equal('foobar')
          expect(await names('')).to.deep.equal([['a.txt', 'file']])
        }
      })

      it.runIf(writes.length > 0)('does not create a missing file, also one removed with its parent since the version', async () => {
        for (const options of writes) {
          await write('dir/a.txt', 'foo')
          const previous = await version('dir/a.txt')
          await rejects(ctx.fs.file(url('dir/b.txt')).write('bar', { ...options, ifMatch: previous }), 'VersionMismatch')
          await ctx.fs.remove(url('dir/a.txt'))
          await rejects(ctx.fs.file(url('dir/a.txt')).write('bar', { ...options, ifMatch: previous }), 'VersionMismatch')
          await ctx.fs.remove(url('dir'))
          await rejects(ctx.fs.file(url('dir/a.txt')).write('bar', { ...options, ifMatch: previous }), 'VersionMismatch')
          expect(await names('')).to.deep.equal([])
        }
      })

      it.runIf(writes.length > 0)('does not replace a directory', async () => {
        await write('a.txt', 'foo')
        const current = await version('a.txt')
        await ctx.fs.mkdir(url('dir'))
        for (const options of writes) {
          await rejects(ctx.fs.file(url('dir')).write('bar', { ...options, ifMatch: current }), 'VersionMismatch')
          expect((await ctx.fs.stat(url('dir'))).type).to.equal('directory')
        }
      })

      it('does not match the version of a file replaced by a rename', async () => {
        await write('a.txt', 'foo')
        const previous = await version('a.txt')
        await write('b.txt', 'foobar')
        await ctx.fs.rename(url('b.txt'), url('a.txt'))
        expect(await version('a.txt')).not.to.equal(previous)
        if (conditional.read) await rejects(ctx.fs.file(url('a.txt')).text({ ifMatch: previous }), 'VersionMismatch')
        for (const options of writes) {
          await rejects(ctx.fs.file(url('a.txt')).write('baz', { ...options, ifMatch: previous }), 'VersionMismatch')
        }
        expect(await text('a.txt')).to.equal('foobar')
      })
    })

    describe('access', () => {
      it('resolves for an existing entry', async () => {
        await write('a.txt')
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.access(url('a.txt'), 'write')
        await ctx.fs.access(url('dir'), 'write')
        await ctx.fs.access(url('dir/'), 'write')
      })

      it('rejects a missing entry', async () => {
        await rejects(ctx.fs.access(url('missing.txt'), 'write'), 'NotFound')
      })
    })

    describe('stat', () => {
      it('reports a file with the length of its content', async () => {
        await write('a.txt', 'foo')
        const stats = await ctx.fs.stat(url('a.txt'))
        expect(stats.type).to.equal('file')
        expect(stats.size).to.equal(3)
        expect(stats.mtime).to.be.instanceOf(Date)
        expect(Number.isNaN(stats.mtime.getTime())).to.equal(false)
      })

      it('reports a directory', async () => {
        await ctx.fs.mkdir(url('dir'))
        expect((await ctx.fs.stat(url('dir'))).type).to.equal('directory')
        expect((await ctx.fs.stat(url('dir/'))).type).to.equal('directory')
        expect((await ctx.fs.stat(base)).type).to.equal('directory')
      })

      it('fails on a missing location', async () => {
        await rejects(ctx.fs.stat(url('missing.txt')), 'NotFound')
        await rejects(ctx.fs.stat(url('missing/a.txt')), 'NotFound')
      })

      it('requires a directory before a trailing separator or a child name', async () => {
        await write('a.txt')
        await rejects(ctx.fs.stat(url('a.txt/')), 'NotADirectory')
        await rejects(ctx.fs.stat(url('a.txt/b.txt')), ...belowFile)
      })
    })

    describe('exists', () => {
      it('resolves to whether an entry exists', async () => {
        await write('a.txt')
        await ctx.fs.mkdir(url('dir'))
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(true)
        expect(await ctx.fs.exists(url('dir'))).to.equal(true)
        expect(await ctx.fs.exists(url('dir/'))).to.equal(true)
        expect(await ctx.fs.exists(url('missing.txt'))).to.equal(false)
        expect(await ctx.fs.exists(url('missing/a.txt'))).to.equal(false)
      })

      it('resolves to `false` for a location below a file', async () => {
        await write('a.txt')
        expect(await ctx.fs.exists(url('a.txt/'))).to.equal(false)
        expect(await ctx.fs.exists(url('a.txt/b.txt'))).to.equal(false)
      })
    })

    describe('readdir', () => {
      it('lists the names, the types and the locations of the entries', async () => {
        await write('dir/a.txt')
        await ctx.fs.mkdir(url('dir/sub'))
        expect(await names('dir')).to.deep.equal([['a.txt', 'file'], ['sub', 'directory']])
        const entries = await list('dir/')
        expect(entries.map(entry => entry.url.href).sort()).to.deep.equal([url('dir/a.txt').href, url('dir/sub').href])
      })

      it('lists an empty directory', async () => {
        await ctx.fs.mkdir(url('dir'))
        expect(await list('dir')).to.deep.equal([])
      })

      it('gives the location of an entry whose name contains characters of a URL', async () => {
        const name = 'a #%b.txt'
        await write('dir/' + encodeURIComponent(name), 'foo')
        const [entry] = await list('dir')
        expect(entry.name).to.equal(name)
        expect(await ctx.fs.file(entry.url).text()).to.equal('foo')
      })

      it('fails from the iteration on a file or a missing location', async () => {
        await write('a.txt')
        const iterable = ctx.fs.readdir(url('a.txt'))
        await rejects(list('a.txt'), 'NotADirectory')
        await rejects(iterable[Symbol.asyncIterator]().next(), 'NotADirectory')
        await rejects(list('a.txt/'), 'NotADirectory')
        await rejects(list('missing'), 'NotFound')
      })
    })

    describe('mkdir', () => {
      it('creates a directory', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.mkdir(url('dir/sub/'))
        expect((await ctx.fs.stat(url('dir/sub'))).type).to.equal('directory')
      })

      it('fails on an existing entry', async () => {
        await ctx.fs.mkdir(url('dir'))
        await write('a.txt', 'foo')
        await rejects(ctx.fs.mkdir(url('dir')), 'AlreadyExists')
        await rejects(ctx.fs.mkdir(url('a.txt')), 'AlreadyExists')
        expect(await text('a.txt')).to.equal('foo')
      })

      it('fails on a missing parent', async () => {
        await rejects(ctx.fs.mkdir(url('missing/dir')), 'NotFound')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('creates the missing parents with `recursive`', async () => {
        await ctx.fs.mkdir(url('a/b/c'), { recursive: true })
        expect((await ctx.fs.stat(url('a/b/c'))).type).to.equal('directory')
      })

      it('accepts an existing directory with `recursive`', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.mkdir(url('dir'), { recursive: true })
        await ctx.fs.mkdir(base, { recursive: true })
        expect(await text('dir/a.txt')).to.equal('foo')
      })

      it('fails on an existing non-directory with `recursive`', async () => {
        await write('a.txt', 'foo')
        await rejects(ctx.fs.mkdir(url('a.txt'), { recursive: true }), 'AlreadyExists')
        await rejects(ctx.fs.mkdir(url('a.txt/dir'), { recursive: true }), 'NotADirectory')
        expect(await text('a.txt')).to.equal('foo')
      })
    })

    describe('rename', () => {
      it('replaces an existing file', async () => {
        await write('a.txt', 'foo')
        await write('b.txt', 'bar')
        await ctx.fs.rename(url('a.txt'), url('b.txt'))
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(false)
        expect(await text('b.txt')).to.equal('foo')
      })

      it('moves a directory with its entries', async () => {
        await write('src/a.txt', 'foo')
        await ctx.fs.rename(url('src'), url('dest/'))
        expect(await text('dest/a.txt')).to.equal('foo')
        expect(await ctx.fs.exists(url('src'))).to.equal(false)
      })

      // Windows renames a directory only to a missing location, and reports a
      // directory as the target as `EPERM`, which is classified as `Busy`
      // without further I/O
      it.skipIf(windows)('replaces an empty directory', async () => {
        await write('src/a.txt', 'foo')
        await ctx.fs.mkdir(url('dest'))
        await ctx.fs.rename(url('src'), url('dest/'))
        expect(await text('dest/a.txt')).to.equal('foo')
        expect(await ctx.fs.exists(url('src'))).to.equal(false)
      })

      // as above
      it.skipIf(windows)('fails on a non-empty directory', async () => {
        await ctx.fs.mkdir(url('a'))
        await write('b/c.txt')
        await rejects(ctx.fs.rename(url('a'), url('b')), 'DirectoryNotEmpty')
        expect(await ctx.fs.exists(url('b/c.txt'))).to.equal(true)
      })

      // as above
      it.skipIf(windows)('fails between a file and a directory', async () => {
        await write('a.txt', 'foo')
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.rename(url('a.txt'), url('dir')), 'IsADirectory')
        await rejects(ctx.fs.rename(url('dir'), url('a.txt')), 'NotADirectory')
        expect(await text('a.txt')).to.equal('foo')
      })

      it('requires a directory for a trailing separator of the destination', async () => {
        await write('a.txt', 'foo')
        await rejects(ctx.fs.rename(url('a.txt'), url('b/')), 'NotADirectory')
        expect(await text('a.txt')).to.equal('foo')

        await ctx.fs.mkdir(url('src'))
        await ctx.fs.rename(url('src'), url('b/'))
        expect((await ctx.fs.stat(url('b'))).type).to.equal('directory')
      })

      it('does not move a directory into itself', async () => {
        await write('dir/a.txt', 'foo')
        expect(await ctx.fs.rename(url('dir'), url('dir/sub')).catch(error => error)).to.be.instanceOf(FsError)
        expect(await text('dir/a.txt')).to.equal('foo')
      })

      it('fails on a missing source or a missing parent of the destination', async () => {
        await write('a.txt', 'foo')
        await rejects(ctx.fs.rename(url('missing.txt'), url('b.txt')), 'NotFound')
        await rejects(ctx.fs.rename(url('a.txt'), url('missing/b.txt')), 'NotFound')
        expect(await text('a.txt')).to.equal('foo')
      })
    })

    describe('remove', () => {
      it('removes a file or an empty directory', async () => {
        await write('a.txt')
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.remove(url('a.txt'))
        await ctx.fs.remove(url('dir'))
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(false)
        expect(await ctx.fs.exists(url('dir'))).to.equal(false)
      })

      it('fails on a non-empty directory', async () => {
        await write('dir/a.txt')
        await rejects(ctx.fs.remove(url('dir')), 'DirectoryNotEmpty')
        expect(await ctx.fs.exists(url('dir/a.txt'))).to.equal(true)
      })

      it('removes a directory with its entries with `recursive`', async () => {
        await write('dir/a.txt')
        await write('dir/sub/b.txt')
        await write('c.txt')
        await ctx.fs.remove(url('dir'), { recursive: true })
        expect(await ctx.fs.exists(url('dir'))).to.equal(false)
        expect(await names('.')).to.deep.equal([['c.txt', 'file']])
      })

      it('removes a file with `recursive`', async () => {
        await write('a.txt')
        await ctx.fs.remove(url('a.txt'), { recursive: true })
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(false)
      })

      it('requires a directory for a trailing separator', async () => {
        await write('a.txt')
        await rejects(ctx.fs.remove(url('a.txt/')), 'NotADirectory')
        await rejects(ctx.fs.remove(url('a.txt/'), { recursive: true }), 'NotADirectory')
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(true)
      })

      it('fails on a missing location unless forced', async () => {
        await rejects(ctx.fs.remove(url('missing.txt')), 'NotFound')
        await rejects(ctx.fs.remove(url('missing'), { recursive: true }), 'NotFound')
        await ctx.fs.remove(url('missing.txt'), { force: true })
        await ctx.fs.remove(url('missing'), { recursive: true, force: true })
      })
    })

    describe('copy', () => {
      it('copies a file, and replaces an existing one', async () => {
        await write('a.txt', 'foo')
        await ctx.fs.copy(url('a.txt'), url('b.txt'))
        expect(await text('b.txt')).to.equal('foo')
        await write('a.txt', 'bar')
        await ctx.fs.copy(url('a.txt'), url('b.txt'))
        expect(await text('b.txt')).to.equal('bar')
        expect(await text('a.txt')).to.equal('bar')
      })

      it.runIf(exclusive)('keeps an existing file with `exclusive: true`', async () => {
        await write('a.txt', 'foo')
        await write('b.txt', 'bar')
        await rejects(ctx.fs.copy(url('a.txt'), url('b.txt'), { exclusive: true }), 'AlreadyExists')
        expect(await text('b.txt')).to.equal('bar')
        await ctx.fs.copy(url('a.txt'), url('c.txt'), { exclusive: true })
        expect(await text('c.txt')).to.equal('foo')
      })

      it('copies a directory with its entries with `recursive`', async () => {
        await write('src/a.txt', 'foo')
        await write('src/sub/b.txt', 'bar')
        await ctx.fs.mkdir(url('src/empty'))
        await rejects(ctx.fs.copy(url('src'), url('dest')), 'IsADirectory')
        expect(await ctx.fs.exists(url('dest'))).to.equal(false)

        await ctx.fs.copy(url('src'), url('dest'), { recursive: true })
        expect(await names('dest')).to.deep.equal([['a.txt', 'file'], ['empty', 'directory'], ['sub', 'directory']])
        expect(await text('dest/a.txt')).to.equal('foo')
        expect(await text('dest/sub/b.txt')).to.equal('bar')
        expect(await text('src/a.txt')).to.equal('foo')
      })

      it('merges a directory into an existing one', async () => {
        await write('src/a.txt', 'foo')
        await write('src/sub/b.txt', 'bar')
        await write('dest/a.txt', 'old')
        await write('dest/sub/c.txt', 'baz')
        await ctx.fs.copy(url('src'), url('dest'), { recursive: true })
        expect(await text('dest/a.txt')).to.equal('foo')
        expect(await text('dest/sub/b.txt')).to.equal('bar')
        expect(await text('dest/sub/c.txt')).to.equal('baz')
      })

      it.runIf(exclusive)('keeps the existing files of a merge with `exclusive: true`', async () => {
        await write('src/a.txt', 'foo')
        await write('dest/a.txt', 'old')
        await rejects(ctx.fs.copy(url('src'), url('dest'), { recursive: true, exclusive: true }), 'AlreadyExists')
        expect(await text('dest/a.txt')).to.equal('old')
      })

      it('fails between a file and a directory', async () => {
        await write('a.txt', 'foo')
        await write('dir/b.txt', 'bar')
        await rejects(ctx.fs.copy(url('a.txt'), url('dir')), 'IsADirectory')
        await rejects(ctx.fs.copy(url('dir'), url('a.txt'), { recursive: true }), 'NotADirectory')
        expect(await text('a.txt')).to.equal('foo')
        expect(await names('dir')).to.deep.equal([['b.txt', 'file']])
      })

      it('fails on a destination at or below the source without changes', async () => {
        await write('dir/a.txt', 'foo')
        await rejects(ctx.fs.copy(url('dir'), url('dir/sub'), { recursive: true }), 'InvalidPath')
        await rejects(ctx.fs.copy(url('dir/'), url('dir'), { recursive: true }), 'InvalidPath')
        await rejects(ctx.fs.copy(url('dir/a.txt'), url('dir/a.txt')), 'InvalidPath')
        expect(await names('dir')).to.deep.equal([['a.txt', 'file']])
        expect(await text('dir/a.txt')).to.equal('foo')
      })

      it('does not create the parent of the destination', async () => {
        await write('a.txt', 'foo')
        await write('dir/b.txt', 'bar')
        await rejects(ctx.fs.copy(url('a.txt'), url('missing/a.txt')), 'NotFound')
        await rejects(ctx.fs.copy(url('dir'), url('missing/dir'), { recursive: true }), 'NotFound')
        expect(await ctx.fs.exists(url('missing'))).to.equal(false)
      })

      it('fails on a missing source', async () => {
        await rejects(ctx.fs.copy(url('missing.txt'), url('b.txt')), 'NotFound')
        expect(await ctx.fs.exists(url('b.txt'))).to.equal(false)
      })
    })

    describe.runIf(symlinks)('symlink', () => {
      // A link to a file requires a privilege on Windows, while a link to a
      // directory may be created as a junction, which stores the absolute target.
      it.skipIf(windows)('stores the target as given, relative to the directory of the link', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('a.txt', url('dir/link'))
        expect(await ctx.fs.readlink(url('dir/link'))).to.equal('a.txt')
        expect(await text('dir/link')).to.equal('foo')
      })

      it('creates a link to a directory', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('dir', url('link'))
        expect(await text('link/a.txt')).to.equal('foo')
      })

      it('fails on an existing entry', async () => {
        await write('a.txt', 'foo')
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.symlink('dir', url('a.txt')), 'AlreadyExists')
        await rejects(ctx.fs.symlink('a.txt', url('dir')), 'AlreadyExists')
        expect(await text('a.txt')).to.equal('foo')
        expect((await ctx.fs.stat(url('dir'), { follow: false })).type).to.equal('directory')
      })

      it('fails to read a location that is not a link', async () => {
        await write('a.txt')
        await ctx.fs.mkdir(url('dir'))
        await rejects(ctx.fs.readlink(url('a.txt')), 'NotALink')
        await rejects(ctx.fs.readlink(url('dir')), 'NotALink')
        await rejects(ctx.fs.readlink(url('missing')), 'NotFound')
      })

      it('reports a link itself with `follow: false`', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        expect((await ctx.fs.stat(url('link'))).type).to.equal('directory')
        expect((await ctx.fs.stat(url('link'), { follow: false })).type).to.equal('symlink')
        // a trailing separator follows a link in the last component
        expect((await ctx.fs.stat(url('link/'), { follow: false })).type).to.equal('directory')
      })

      it.skipIf(windows)('reports a dangling link only with `follow: false`', async () => {
        await ctx.fs.symlink('missing', url('link'))
        await rejects(ctx.fs.stat(url('link')), 'NotFound')
        expect((await ctx.fs.stat(url('link'), { follow: false })).type).to.equal('symlink')
        expect(await ctx.fs.exists(url('link'))).to.equal(false)
      })

      it('lists a link with its own type', async () => {
        await ctx.fs.mkdir(url('dir/target'), { recursive: true })
        await ctx.fs.symlink('target', url('dir/link'))
        expect(await names('dir')).to.deep.equal([['link', 'symlink'], ['target', 'directory']])
      })

      it('accepts an existing directory through a link with `recursive`', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.mkdir(url('link'), { recursive: true })
        await rejects(ctx.fs.mkdir(url('link')), 'AlreadyExists')
      })

      it('removes a link without its target', async () => {
        await write('dir/a.txt')
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.remove(url('link'))
        expect(await ctx.fs.exists(url('link'))).to.equal(false)
        expect(await ctx.fs.exists(url('dir/a.txt'))).to.equal(true)
      })

      it('removes a link without its target with `recursive`, also named with a trailing separator', async () => {
        await write('dir/a.txt')
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.symlink('dir', url('other'))
        await ctx.fs.remove(url('link'), { recursive: true })
        await ctx.fs.remove(url('other/'), { recursive: true })
        expect(await names('.')).to.deep.equal([['dir', 'directory']])
        expect(await ctx.fs.exists(url('dir/a.txt'))).to.equal(true)
      })

      it('removes the links below a directory without their targets with `recursive`', async () => {
        await write('target/a.txt')
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('../target', url('dir/link'))
        await ctx.fs.remove(url('dir'), { recursive: true })
        expect(await ctx.fs.exists(url('dir'))).to.equal(false)
        expect(await ctx.fs.exists(url('target/a.txt'))).to.equal(true)
      })

      it('removes a link named with a trailing separator without its target', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.remove(url('link/'))
        expect(await ctx.fs.exists(url('link'))).to.equal(false)
        expect(await ctx.fs.exists(url('dir'))).to.equal(true)
      })

      // creating a link to a file requires a privilege on Windows
      it.skipIf(windows)('keeps a link to a file named with a trailing separator', async () => {
        await write('a.txt')
        await ctx.fs.symlink('a.txt', url('link'))
        await rejects(ctx.fs.remove(url('link/')), 'NotADirectory')
        expect((await ctx.fs.stat(url('link'), { follow: false })).type).to.equal('symlink')
        expect(await ctx.fs.exists(url('a.txt'))).to.equal(true)
      })

      it('renames a link named with a trailing separator without its target', async () => {
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        await ctx.fs.rename(url('link/'), url('moved'))
        expect((await ctx.fs.stat(url('moved'), { follow: false })).type).to.equal('symlink')
        expect(await ctx.fs.exists(url('link'))).to.equal(false)
        expect(await ctx.fs.exists(url('dir'))).to.equal(true)
      })

      it('does not replace the target of a link named with a trailing separator', async () => {
        await write('src/a.txt')
        await ctx.fs.mkdir(url('dir'))
        await ctx.fs.symlink('dir', url('link'))
        // the link may be replaced, or the rename may fail
        await ctx.fs.rename(url('src'), url('link/')).catch(() => {})
        expect(await ctx.fs.exists(url('dir/a.txt'))).to.equal(false)
      })

      // as above
      it.skipIf(windows)('copies a link as a link', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('a.txt', url('dir/link'))
        await ctx.fs.copy(url('dir'), url('copied'), { recursive: true })
        expect(await ctx.fs.readlink(url('copied/link'))).to.equal('a.txt')
        await ctx.fs.copy(url('dir/link'), url('link'))
        expect(await ctx.fs.readlink(url('link'))).to.equal('a.txt')
        await rejects(ctx.fs.copy(url('dir/link'), url('link'), { exclusive: true }), 'AlreadyExists')
      })

      // as above
      it.runIf(exclusive && !windows)('exclusively creates the file named by a dangling destination link', async () => {
        await ctx.fs.symlink('missing', url('link'))
        const entry = ctx.fs.file(url('link'))
        await entry.write('first', { exclusive: true })
        await rejects(entry.write('second', { exclusive: true }), 'AlreadyExists')
        expect(await text('missing')).to.equal('first')
        expect(await ctx.fs.readlink(url('link'))).to.equal('missing')
      })

      it.runIf(exclusive && !windows)('copies a file through a dangling link, also with `exclusive: true`', async () => {
        await write('a.txt', 'foo')
        await ctx.fs.symlink('target.txt', url('link'))
        await ctx.fs.copy(url('a.txt'), url('link'), { exclusive: true })
        expect(await text('target.txt')).to.equal('foo')
        expect((await ctx.fs.stat(url('link'), { follow: false })).type).to.equal('symlink')
        await rejects(ctx.fs.copy(url('a.txt'), url('link'), { exclusive: true }), 'AlreadyExists')
      })

      it.skipIf(windows)('copies what a link points to with `dereference`', async () => {
        await write('dir/a.txt', 'foo')
        await ctx.fs.symlink('a.txt', url('dir/link'))
        await ctx.fs.symlink('dir', url('outer'))
        await ctx.fs.copy(url('outer'), url('copied'), { recursive: true, dereference: true })
        expect((await ctx.fs.stat(url('copied'), { follow: false })).type).to.equal('directory')
        expect((await ctx.fs.stat(url('copied/link'), { follow: false })).type).to.equal('file')
        expect(await text('copied/link')).to.equal('foo')
      })
    })

    describe.runIf(!symlinks)('symlink', () => {
      it('fails to create or read a link with `NotSupported`', async () => {
        await write('a.txt')
        await rejects(ctx.fs.symlink('a.txt', url('link')), 'NotSupported')
        await rejects(ctx.fs.readlink(url('a.txt')), 'NotSupported')
      })
    })

    describe('slice', () => {
      const content = '0123456789'

      it('reads a range with the semantics of `Blob.slice()`', async () => {
        await write('a.txt', content)
        const file = ctx.fs.file(url('a.txt'))
        const blob = new Blob([content])
        const ranges: [number?, number?][] = [
          [], [2], [2, 5], [-3], [-5, -2], [3, -2], [-20, 2], [8, -5], [5, 2], [20], [0, 20], [10],
          [2 ** 53], [0, 2 ** 60], [-(2 ** 60)],
        ]
        for (const [start, end] of ranges) {
          expect(await file.slice(start, end).text(), `slice(${start}, ${end})`).to.equal(await blob.slice(start, end).text())
        }
      })

      it('reads a slice of a slice relative to the slice', async () => {
        await write('a.txt', content)
        const file = ctx.fs.file(url('a.txt'))
        const blob = new Blob([content])
        const ranges: [number?, number?][][] = [
          [[2, 8], [1, 3]], [[-6], [-3, -1]], [[2], [-3]], [[1, -1], [2, 100]], [[5, 2], [0, 1]], [[1], [1], [1, 3]],
          [[Number.MAX_SAFE_INTEGER], [1]],
        ]
        for (const chain of ranges) {
          const [slice, expected] = chain.reduce(([slice, expected], [start, end]) => {
            return [slice.slice(start, end), expected.slice(start, end)] as const
          }, [file, blob] as const)
          expect(await slice.text(), JSON.stringify(chain)).to.equal(await expected.text())
        }
      })

      it('reads a range of a content of several chunks', async () => {
        const bytes = new Uint8Array(200 * 1024).map((_, index) => index % 251)
        await write('a.bin', bytes)
        const file = ctx.fs.file(url('a.bin'))
        expect(await file.slice(70000, 140000).bytes()).to.deep.equal(bytes.slice(70000, 140000))
        expect(await file.slice(-70000).bytes()).to.deep.equal(bytes.slice(-70000))
      })

      it('fails to read a slice of a missing file or of a directory, also if it is empty', async () => {
        await ctx.fs.mkdir(url('dir'))
        for (const [start, end] of [[1, 2], [0, 0], [-2]]) {
          await rejects(ctx.fs.file(url('missing.txt')).slice(start, end).text(), 'NotFound')
          await rejects(ctx.fs.file(url('dir')).slice(start, end).text(), 'IsADirectory')
        }
      })

      it('rejects a write to a slice with a `TypeError`', async () => {
        await write('a.txt', content)
        const error = await ctx.fs.file(url('a.txt')).slice(1).write('foo').catch(error => error)
        expect(error).to.be.instanceOf(TypeError)
        expect(await text('a.txt')).to.equal(content)
      })
    })

    describe('location', () => {
      it('does not apply an operation on a directory location to a file', async () => {
        await write('a.txt', 'foo')
        const dir = url('a.txt/')
        await rejects(ctx.fs.file(dir).text(), 'IsADirectory')
        await rejects(ctx.fs.file(dir).write('bar'), 'IsADirectory')
        // each operation is started after the previous one has settled
        for (const operation of [
          () => ctx.fs.access(dir, 'write'),
          () => ctx.fs.stat(dir),
          () => list('a.txt/'),
          () => ctx.fs.rename(dir, url('b.txt')),
          () => ctx.fs.copy(dir, url('b.txt')),
          () => ctx.fs.remove(dir),
        ]) {
          await rejects(operation(), 'NotADirectory')
        }
        expect(await text('a.txt')).to.equal('foo')
      })
    })
  })
}
