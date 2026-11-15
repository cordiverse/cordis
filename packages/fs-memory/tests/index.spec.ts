import { Context, Fiber } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import Fs, { FsError, WatchOptions } from '@cordisjs/fs'
import MemoryFs, { Volume } from '../src/index.ts'

async function rejects(promise: Promise<unknown>, code: FsError.Code) {
  const error = await promise.then(() => undefined, error => error)
  expect(error).to.be.instanceOf(FsError)
  expect(error.code).to.equal(code)
  return error as FsError
}

describe('Volume', () => {
  const fibers: Fiber[] = []

  afterEach(async () => {
    for (const fiber of fibers.splice(0)) await fiber.dispose()
  })

  async function setup(files: Volume.Tree = {}, options?: Volume.Options) {
    const ctx = new Context()
    fibers.push(await ctx.plugin(Fs, { baseUrl: 'memory://app/' }))
    const volume = new Volume(files, options)
    ctx.fs.mount('memory:', volume)
    return { ctx, volume }
  }

  describe('files', () => {
    it('creates the initial entries and their parent directories', async () => {
      const { ctx } = await setup({
        'memory://app/a/b.txt': 'foo',
        'memory://app/dir': {
          'c.txt': 'bar',
          'nested/d.bin': new Uint8Array([1, 2, 3]),
          'empty': {},
        },
      })
      expect(await ctx.fs.file('a/b.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('dir/c.txt').text()).to.equal('bar')
      expect(await ctx.fs.file('dir/nested/d.bin').bytes()).to.deep.equal(new Uint8Array([1, 2, 3]))
      await ctx.fs.remove('dir/empty/')
    })

    it('rejects a file below another file', () => {
      expect(() => new Volume({ 'memory:///a': 'foo', 'memory:///a/b': 'bar' }))
        .to.throw(FsError).with.property('code', 'NotADirectory')
    })
  })

  describe('read', () => {
    it('reads the current content', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': 'foo' })
      const file = ctx.fs.file('a.txt')
      expect(await file.text()).to.equal('foo')
      await file.write('bar')
      expect(await file.text()).to.equal('bar')
    })

    it('streams the content in chunks of `chunkSize`', async () => {
      const content = new Uint8Array(10).map((_, index) => index)
      const { ctx } = await setup({ 'memory://app/a.bin': content }, { chunkSize: 4 })
      const chunks: number[] = []
      for await (const chunk of ctx.fs.file('a.bin').stream()) chunks.push(chunk.byteLength)
      expect(chunks).to.deep.equal([4, 4, 2])
      expect(await ctx.fs.file('a.bin').bytes()).to.deep.equal(content)
    })

    it('keeps the content that a read started with', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': 'foo' }, { chunkSize: 1 })
      const reader = ctx.fs.file('a.txt').stream().getReader()
      const first = await reader.read()
      await ctx.fs.file('a.txt').write('bar')
      const second = await reader.read()
      expect(new TextDecoder().decode(new Uint8Array([...first.value!, ...second.value!]))).to.equal('fo')
    })

    it('does not let a reader modify the stored content', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': 'foo' })
      const bytes = await ctx.fs.file('a.txt').bytes()
      bytes.fill(0)
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
    })

    it('fails on a missing file with the location', async () => {
      const { ctx } = await setup()
      const file = ctx.fs.file('missing.txt')
      const error = await rejects(file.text(), 'NotFound')
      expect(error.url?.href).to.equal(file.url.href)
    })

    it('fails on a directory', async () => {
      const { ctx } = await setup({ 'memory://app/dir/a.txt': '' })
      await rejects(ctx.fs.file('dir').text(), 'IsADirectory')
      await rejects(ctx.fs.file('a.txt/').text(), 'IsADirectory')
    })

    it('fails below a file', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': '' })
      await rejects(ctx.fs.file('a.txt/b.txt').text(), 'NotADirectory')
    })
  })

  describe('write', () => {
    it('creates a file or replaces its content', async () => {
      const { ctx } = await setup()
      await ctx.fs.file('a.txt').write('foo')
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
      await ctx.fs.file('a.txt').write(new Uint8Array([0x62]))
      expect(await ctx.fs.file('a.txt').text()).to.equal('b')
    })

    it('does not create the parent directory', async () => {
      const { ctx } = await setup()
      await rejects(ctx.fs.file('missing/a.txt').write('foo'), 'NotFound')
      await rejects(ctx.fs.access('missing', 'write'), 'NotFound')
    })

    it('fails on a directory', async () => {
      const { ctx } = await setup({ 'memory://app/dir/a.txt': '' })
      await rejects(ctx.fs.file('dir').write('foo'), 'IsADirectory')
      await rejects(ctx.fs.file('b.txt/').write('foo'), 'IsADirectory')
      await rejects(ctx.fs.access('b.txt', 'write'), 'NotFound')
    })

    it('rejects with the error of the stream and keeps the previous content', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': 'foo' })
      const error = new Error('aborted')
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('bar'))
          controller.error(error)
        },
      })
      expect(await ctx.fs.file('a.txt').write(body).catch(error => error)).to.equal(error)
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
    })

    it('fails when the parent directory is removed while the body is consumed', async () => {
      const { ctx } = await setup({ 'memory://app/dir/': {} })
      let resume!: () => void
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise<void>(resolve => resume = resolve)
          controller.enqueue(new TextEncoder().encode('foo'))
          controller.close()
        },
      })
      const write = ctx.fs.file('dir/a.txt').write(body)
      await new Promise(resolve => setTimeout(resolve))
      await ctx.fs.remove('dir')
      resume()
      await rejects(write, 'NotFound')
    })
  })

  describe('access', () => {
    it('resolves for an existing entry and rejects a missing one', async () => {
      const { ctx } = await setup({ 'memory://app/dir/a.txt': '' })
      await ctx.fs.access('dir/a.txt', 'write')
      await ctx.fs.access('dir/', 'write')
      await rejects(ctx.fs.access('missing.txt', 'write'), 'NotFound')
      await rejects(ctx.fs.access('dir/a.txt/', 'write'), 'NotADirectory')
    })
  })

  describe('rename', () => {
    it('replaces an existing file', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': 'foo', 'memory://app/b.txt': 'bar' })
      await ctx.fs.rename('a.txt', 'b.txt')
      await rejects(ctx.fs.access('a.txt', 'write'), 'NotFound')
      expect(await ctx.fs.file('b.txt').text()).to.equal('foo')
    })

    it('moves a directory with its entries, and replaces an empty one', async () => {
      const { ctx } = await setup({ 'memory://app/src/a.txt': 'foo', 'memory://app/dest/': {} })
      await ctx.fs.rename('src', 'dest/')
      expect(await ctx.fs.file('dest/a.txt').text()).to.equal('foo')
      await rejects(ctx.fs.access('src', 'write'), 'NotFound')
    })

    it('fails on a non-empty directory', async () => {
      const { ctx } = await setup({ 'memory://app/a/': {}, 'memory://app/b/c.txt': '' })
      await rejects(ctx.fs.rename('a', 'b'), 'DirectoryNotEmpty')
      await ctx.fs.access('b/c.txt', 'write')
    })

    it('fails between a file and a directory', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': 'foo', 'memory://app/dir/': {} })
      await rejects(ctx.fs.rename('a.txt', 'dir'), 'IsADirectory')
      await rejects(ctx.fs.rename('dir', 'a.txt'), 'NotADirectory')
      await rejects(ctx.fs.rename('a.txt', 'b/'), 'NotADirectory')
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
    })

    it('does not move a directory into itself', async () => {
      const { ctx } = await setup({ 'memory://app/dir/a.txt': 'foo' })
      expect(await ctx.fs.rename('dir', 'dir/sub').catch(error => error)).to.be.instanceOf(FsError)
      expect(await ctx.fs.file('dir/a.txt').text()).to.equal('foo')
    })

    it('fails on a missing source or a missing parent of the destination', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': 'foo' })
      await rejects(ctx.fs.rename('missing.txt', 'b.txt'), 'NotFound')
      await rejects(ctx.fs.rename('a.txt', 'missing/b.txt'), 'NotFound')
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
    })
  })

  describe('remove', () => {
    it('removes a file or an empty directory', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': '', 'memory://app/dir/': {} })
      await ctx.fs.remove('a.txt')
      await ctx.fs.remove('dir')
      await rejects(ctx.fs.access('a.txt', 'write'), 'NotFound')
      await rejects(ctx.fs.access('dir', 'write'), 'NotFound')
    })

    it('fails on a non-empty directory', async () => {
      const { ctx } = await setup({ 'memory://app/dir/a.txt': '' })
      await rejects(ctx.fs.remove('dir'), 'DirectoryNotEmpty')
      await ctx.fs.access('dir/a.txt', 'write')
    })

    it('requires a directory for a trailing separator', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': '' })
      await rejects(ctx.fs.remove('a.txt/'), 'NotADirectory')
      await ctx.fs.access('a.txt', 'write')
    })

    it('fails on a missing location unless forced', async () => {
      const { ctx } = await setup()
      await rejects(ctx.fs.remove('missing.txt'), 'NotFound')
      await ctx.fs.remove('missing.txt', { force: true })
    })
  })

  describe('location', () => {
    it('keeps the entries of each root apart', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': 'app', 'memory://other/a.txt': 'other' })
      expect(await ctx.fs.file('memory://app/a.txt').text()).to.equal('app')
      expect(await ctx.fs.file('memory://other/a.txt').text()).to.equal('other')
    })

    it('names an entry by its decoded path', async () => {
      const { ctx } = await setup({ 'memory://app/a b/c%23d.txt': 'foo' })
      expect(await ctx.fs.file('memory://app/a%20b/c%23d.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('memory://app/a%20b//c%23d.txt').text()).to.equal('foo')
      await ctx.fs.file('memory://app/%41.txt').write('bar')
      expect(await ctx.fs.file('memory://app/A.txt').text()).to.equal('bar')
    })

    it('rejects a location without a hierarchical path, or with a query, a fragment or an encoded separator', async () => {
      const { ctx } = await setup({ 'memory://app/a/b': 'foo' })
      for (const location of ['memory:a', 'memory://app/a/b?x', 'memory://app/a/b#x', 'memory://app/a%2Fb']) {
        await rejects(ctx.fs.file(location).text(), 'InvalidPath')
      }
      expect(() => ctx.fs.watch('memory:a')).to.throw(FsError).with.property('code', 'InvalidPath')
    })
  })

  describe('hook', () => {
    it('fails an operation with the error of the hook', async () => {
      const denied = new URL('memory://app/a.txt')
      const { ctx } = await setup({ 'memory://app/a.txt': 'foo' }, {
        hook(operation, url) {
          if (url.href === denied.href && operation !== 'access') {
            throw new FsError('PermissionDenied', url, `cannot ${operation} ${url.href}`)
          }
        },
      })
      await rejects(ctx.fs.file('a.txt').text(), 'PermissionDenied')
      await rejects(ctx.fs.file('a.txt').write('bar'), 'PermissionDenied')
      await rejects(ctx.fs.remove('a.txt'), 'PermissionDenied')
      await ctx.fs.access('a.txt', 'write')
    })
  })

  describe('watch', () => {
    function watch(ctx: Context, path: string, options?: WatchOptions) {
      const seen: string[] = []
      ctx.fs.watch(path, options).on('change', (url) => { seen.push(url.href) })
      return seen
    }

    it('reports each write to a watched file when it completes', async () => {
      const { ctx } = await setup({ 'memory://app/a.txt': '' })
      const seen = watch(ctx, 'a.txt')
      await ctx.fs.file('a.txt').write('foo')
      await ctx.fs.file('b.txt').write('foo')
      expect(seen).to.deep.equal(['memory://app/a.txt'])
    })

    it('reports a file created or replaced through a rename at a watched location', async () => {
      const { ctx } = await setup()
      const seen = watch(ctx, 'a.txt')
      await ctx.fs.file('a.txt.tmp').write('foo')
      await ctx.fs.rename('a.txt.tmp', 'a.txt')
      await ctx.fs.file('a.txt.tmp').write('bar')
      await ctx.fs.rename('a.txt.tmp', 'a.txt')
      expect(seen).to.deep.equal(['memory://app/a.txt', 'memory://app/a.txt'])
    })

    it('reports the files below a watched directory, also those moved into it', async () => {
      const { ctx } = await setup({ 'memory://app/dir/nested/': {}, 'memory://app/src/x/a.txt': '' })
      const seen = watch(ctx, 'dir/')
      await ctx.fs.file('dir/nested/b.txt').write('foo')
      await ctx.fs.rename('src', 'dir/src')
      expect(seen).to.deep.equal(['memory://app/dir/nested/b.txt', 'memory://app/dir/src/x/a.txt'])
    })

    it('reports a location whose names contain characters that end a path', async () => {
      const { ctx } = await setup()
      const seen = watch(ctx, '.')
      await ctx.fs.file('a%23b%3Fc%25d.txt').write('')
      expect(seen).to.deep.equal(['memory://app/a%23b%3Fc%25d.txt'])
    })

    it('applies `filter` to the entries below a watched directory and their ancestors', async () => {
      const { ctx } = await setup({ 'memory://app/dir/lib/': {}, 'memory://app/dir/src/': {} })
      const tested: [string, boolean][] = []
      const seen = watch(ctx, 'dir', {
        filter: (path, isDirectory) => {
          tested.push([path, isDirectory])
          return path !== 'lib'
        },
      })
      await ctx.fs.file('dir/lib/a.txt').write('')
      await ctx.fs.file('dir/src/a.txt').write('')
      expect(seen).to.deep.equal(['memory://app/dir/src/a.txt'])
      expect(tested).to.deep.include.members([['lib', true], ['src', true], ['src/a.txt', false]])
    })

    it('selects the files by glob patterns', async () => {
      const { ctx } = await setup({ 'memory://app/dir/src/': {}, 'memory://app/dir/lib/': {} })
      const seen = watch(ctx, 'dir', { filter: ['src/**/*.ts', '!src/**/*.spec.ts'] })
      for (const name of ['src/a.ts', 'src/a.spec.ts', 'lib/b.ts']) {
        await ctx.fs.file(`dir/${name}`).write('')
      }
      expect(seen).to.deep.equal(['memory://app/dir/src/a.ts'])
    })

    it('does not apply `filter` to a watched file', async () => {
      const { ctx } = await setup()
      const seen = watch(ctx, 'a.txt', { filter: () => false })
      await ctx.fs.file('a.txt').write('')
      expect(seen).to.deep.equal(['memory://app/a.txt'])
    })

    it('reports `ready`, and nothing once disposed', async () => {
      const { ctx } = await setup()
      const watcher = ctx.fs.watch('a.txt')
      const seen: string[] = []
      watcher.on('change', (url) => { seen.push(url.href) })
      await new Promise<void>(resolve => watcher.on('ready', resolve))
      await watcher.dispose()
      await ctx.fs.file('a.txt').write('')
      expect(seen).to.deep.equal([])
    })
  })
})

describe('MemoryFs', () => {
  it('mounts a volume with the initial entries at `memory:`, or at `config.mount`', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs, { baseUrl: 'memory://app/' })
    try {
      await ctx.plugin(MemoryFs, { files: { 'memory://app/a.txt': 'foo' } })
      await ctx.plugin(MemoryFs, { mount: 'other:', files: { 'other:///a.txt': 'bar' } })
      expect(await ctx.fs.file('a.txt').text()).to.equal('foo')
      expect(await ctx.fs.file('other:///a.txt').text()).to.equal('bar')
    } finally {
      await fiber.dispose()
    }
  })
})
