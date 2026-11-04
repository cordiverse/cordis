import { Context, Fiber } from 'cordis'
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FSWatcher } from 'chokidar'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Fs, { WatchOptions } from '../src/index.ts'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__fixtures__')

function waitFor(condFn: () => any, timeout = 8000, interval = 50): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      if (!condFn()) return
      clearInterval(check)
      clearTimeout(timer)
      resolve()
    }, interval)
    const timer = setTimeout(() => {
      clearInterval(check)
      reject(new Error('waitFor timed out'))
    }, timeout)
  })
}

// The OS may not deliver events until a while after the watch is set up,
// especially for the first watch in a process, so the file is written until
// the change is seen.
async function touch(paths: string | string[], condFn: () => any) {
  for (let i = 0; !condFn(); i++) {
    if (i >= 80) throw new Error('touch timed out')
    for (const path of [paths].flat()) writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

function write(name: string, content = '') {
  const path = resolve(fixture, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

// resolves once the initial scan is done
async function watch(ctx: Context, path: string | URL, listener: (filename: string) => void, options?: WatchOptions) {
  const watcher = ctx.fs.watch(path, options)
  watcher.on('change', listener)
  await new Promise<void>(resolve => watcher.on('ready', resolve))
  return watcher
}

describe('Fs', () => {
  let fiber: Fiber<Context> | undefined

  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(fixture, { recursive: true })
  })

  afterEach(async () => {
    // watches end with the plugins that inject `fs`
    await fiber?.dispose()
    fiber = undefined
  })

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true })
  })

  async function setup(baseUrl: string | null = import.meta.url) {
    const root = new Context()
    root.baseUrl = baseUrl ?? undefined
    fiber = await root.plugin(Fs)
    let ctx!: Context
    await root.inject(['fs'], (inner) => { ctx = inner })
    return ctx
  }

  describe('path', () => {
    it('resolves a relative path against the calling context', async () => {
      const path = write('base with spaces # %/relative.txt')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, '__fixtures__/base with spaces # %/relative.txt', (filename) => { seen.push(filename) })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('resolves a relative path against the working directory without a context directory', async () => {
      const path = write('cwd.txt')
      const ctx = await setup(null)
      const seen: string[] = []
      await watch(ctx, relative(process.cwd(), path), (filename) => { seen.push(filename) })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('accepts a file URL', async () => {
      const path = write('base with spaces # %/url.txt')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, pathToFileURL(path).href, (filename) => { seen.push(filename) })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    // `fileURLToPath()` keeps the trailing slash of a directory URL.
    it.each([
      ['string', (path: string) => pathToFileURL(path).href + '/'],
      ['object', (path: string) => new URL(pathToFileURL(path).href + '/')],
    ])('accepts a directory URL with a trailing slash as a %s', async (kind, toUrl) => {
      const path = write(`url-dir-${kind}/file.txt`)
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, toUrl(dirname(path)), (filename) => { seen.push(filename) }, {
        filter: path => path === 'file.txt',
      })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it.runIf(process.platform === 'win32')('matches paths that differ in case on Windows', async () => {
      const path = write('case.txt')
      const ctx = await setup()
      let calls = 0
      // drive letter and directories alike
      const dir = dirname(path).replace(/[a-z]/gi, c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())
      await watch(ctx, resolve(dir, basename(path)), () => { calls++ })

      await touch(path, () => calls > 0)
    }, 15000)

    // `_resolve` rather than `watch()`: without the guard these start a recursive
    // watch on a real volume and hang, which hides the result instead of failing it.
    it.runIf(process.platform === 'win32')('rejects a file URL that resolves to a drive-relative path', async () => {
      const ctx = await setup()
      const resolved = (input: string | URL) => (ctx.fs as any)._resolve(input)
      for (const input of ['file:C:', 'file:/C:', 'file:/../C:', 'file:.\\C:']) {
        expect(() => resolved(input), `${input} resolved to a drive-relative path`)
          .to.throw(/drive-relative form/)
      }
    }, 15000)

    // the string branch reaches the same state through `resolve('C:')`
    it.runIf(process.platform === 'win32')('rejects a drive-relative path passed as a plain string', async () => {
      const ctx = await setup()
      const resolved = (input: string | URL) => (ctx.fs as any)._resolve(input)
      // `C:Windows` is the shape that matters: it resolves to a real directory
      for (const input of ['C:', 'c:', 'X:', 'Z:', 'C:.', 'C:..', 'C:./', 'C:x\\..', 'c:foo', 'C:Windows']) {
        expect(() => resolved(input), `${input} is drive-relative, not a path`)
          .to.throw(/drive-relative form/)
      }
    }, 15000)

    it.runIf(process.platform === 'win32')('does not reject a path that names a location on a drive', async () => {
      const ctx = await setup()
      const resolved = (input: string | URL) => (ctx.fs as any)._resolve(input)
      for (const input of ['C:\\', 'C:\\x', 'C:\\x\\y.yml', 'C:/x', 'C://x', 'C://x//y.yml', 'C://', '\\\\server\\share\\x']) {
        expect(isAbsolute(resolved(input)), `${input} names a location on a drive`).to.be.true
      }
    }, 15000)

    // says so if a future Node rejects these itself, leaving the guard unreachable
    it.runIf(process.platform === 'win32')('is reached because `fileURLToPath` yields a drive-relative path', () => {
      const nonAbsolute = ['file:C:', 'file:/C:', 'file:/../C:', 'file:.\\C:']
        .map((input) => fileURLToPath(input))
        .filter((out) => !isAbsolute(out))
      expect(nonAbsolute, '`fileURLToPath` no longer yields a drive-relative path, so the guard is unreachable').to.not.be.empty
    })

  })

  describe('watch', () => {
    // an atomic write replaces the file through a rename
    it('keeps watching a file replaced through renames', async () => {
      const path = write('atomic/config.yml')
      const sibling = write('atomic/sibling.yml')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, path, (filename) => { seen.push(filename) })

      for (const value of ['v1', 'v2']) {
        writeFileSync(path + '.tmp', value)
        renameSync(path + '.tmp', path)
      }
      await new Promise(r => setTimeout(r, 500))
      seen.length = 0

      await touch([path, sibling], () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('reports the changed file of a watched directory', async () => {
      const path = write('dir/nested/file.txt')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, resolve(fixture, 'dir'), (filename) => { seen.push(filename) })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('applies `filter` to each watch on its own', async () => {
      const kept = write('filtered/kept.txt')
      const claimed = write('filtered/.claimed.yml')
      const ctx = await setup()
      const fromDir: string[] = []
      const fromFile: string[] = []
      await watch(ctx, resolve(fixture, 'filtered'), (filename) => { fromDir.push(filename) }, {
        filter: path => !path.startsWith('.'),
      })
      await watch(ctx, claimed, (filename) => { fromFile.push(filename) })

      await touch([claimed, kept], () => fromDir.length && fromFile.length)
      await new Promise(r => setTimeout(r, 200))
      expect([...new Set(fromDir)]).to.deep.equal([kept])
      expect([...new Set(fromFile)]).to.deep.equal([claimed])
    }, 15000)

    it('passes `filter` the paths relative to the watched directory and their types', async () => {
      const path = write('relative/nested/file.txt')
      const ctx = await setup()
      const tested: [string, boolean][] = []
      const seen: string[] = []
      await watch(ctx, resolve(fixture, 'relative'), (filename) => { seen.push(filename) }, {
        filter: (path, isDirectory) => {
          tested.push([path, isDirectory])
          return true
        },
      })

      await touch(path, () => seen.length)
      expect(tested).to.deep.include.members([['nested', true], ['nested/file.txt', false]])
      expect(tested.filter(([path]) => !path || isAbsolute(path) || path.includes('\\'))).to.deep.equal([])
    }, 15000)

    it('selects the files by glob patterns relative to the watched directory', async () => {
      const selected = [
        write('glob/lib/file.txt'),
        write('glob/src/index.ts'),
        write('glob/src/deep/index.ts'),
        write('glob/src/log1.ts'),
        write('glob/packages/a/deep/file.js'),
      ]
      const others = [
        write('glob/lib/.hidden.txt'),
        write('glob/src/index.js'),
        write('glob/src/logx.ts'),
        write('glob/other.txt'),
      ]
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, resolve(fixture, 'glob'), (filename) => { seen.push(filename) }, {
        filter: ['lib', 'src/**/*.ts', 'packages/*', '!**/.*', '!src/log[!0-9].ts'],
      })

      await touch([...selected, ...others], () => selected.every(path => seen.includes(path)))
      await new Promise(r => setTimeout(r, 200))
      expect([...new Set(seen)].sort()).to.deep.equal(selected.sort())
    }, 15000)

    it('decides an entry by the last pattern that matches it or one of its ancestors', async () => {
      const selected = [
        write('ordered/src/index.ts'),
        write('ordered/src/gen/keep.ts'),
      ]
      const others = [
        write('ordered/src/gen/other.ts'),
      ]
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, resolve(fixture, 'ordered'), (filename) => { seen.push(filename) }, {
        filter: ['src', '!src/gen', 'src/gen/keep.ts'],
      })

      await touch([...selected, ...others], () => selected.every(path => seen.includes(path)))
      await new Promise(r => setTimeout(r, 200))
      expect([...new Set(seen)].sort()).to.deep.equal(selected.sort())
    }, 15000)

    it('descends into a directory whose name a pattern escapes', async () => {
      const path = write('escaped/pkg[one]/file.ts')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, resolve(fixture, 'escaped'), (filename) => { seen.push(filename) }, {
        filter: ['pkg\\[one\\]/*.ts'],
      })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('treats a symbolic link to a directory as a directory', async () => {
      const target = write('symlink/target/file.ts')
      const link = resolve(fixture, 'symlink/root/linked')
      mkdirSync(dirname(link), { recursive: true })
      // a junction needs no privilege on Windows, and the type is ignored elsewhere
      symlinkSync(dirname(target), link, 'junction')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, dirname(link), (filename) => { seen.push(filename) }, {
        filter: ['linked/**/*.ts'],
      })

      await touch(target, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([resolve(link, 'file.ts')])
    }, 15000)

    it('treats a file replaced with a symbolic link to a directory as a directory', async () => {
      const target = write('relinked/target/file.ts')
      const link = write('relinked/root/linked')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, dirname(link), (filename) => { seen.push(filename) }, {
        filter: ['linked/**/*.ts'],
      })

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')
      await touch(target, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([resolve(link, 'file.ts')])
    }, 15000)

    it('keeps no entry with an empty `filter`', async () => {
      const path = write('empty/file.txt')
      const ctx = await setup()
      const seen: string[] = []
      const fromFile: string[] = []
      await watch(ctx, resolve(fixture, 'empty'), (filename) => { seen.push(filename) }, { filter: [] })
      await watch(ctx, path, (filename) => { fromFile.push(filename) })

      await touch(path, () => fromFile.length)
      await new Promise(r => setTimeout(r, 200))
      expect(seen).to.deep.equal([])
    }, 15000)

    it('rejects a `filter` entry leading outside the watched directory', async () => {
      const ctx = await setup()
      for (const entry of ['../outside', '!../outside', 'a/../../outside', '/absolute']) {
        expect(() => ctx.fs.watch(fixture, { filter: [entry] })).to.throw(TypeError)
      }
    })

    it('does not apply `filter` to the watched directory', async () => {
      const path = write('.root/file.txt')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, resolve(fixture, '.root'), (filename) => { seen.push(filename) }, {
        filter: ['.', '!**/.*'],
      })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('does not apply `filter` to a watched file', async () => {
      const path = write('.parent/.file')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, path, (filename) => { seen.push(filename) }, { filter: [] })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('runs every callback registered for the same path', async () => {
      const path = write('shared.txt')
      const ctx = await setup()
      const seen: string[] = []
      await watch(ctx, path, () => { seen.push('a') })
      await watch(ctx, path, () => { seen.push('b') })

      await touch(path, () => seen.length >= 2)
      expect([...new Set(seen)].sort()).to.deep.equal(['a', 'b'])
    }, 15000)

    it('stops calling a listener once the watch is disposed', async () => {
      const path = write('dispose.txt')
      const ctx = await setup()
      let calls = 0
      let others = 0
      const watcher = await watch(ctx, path, () => { calls++ })
      await watch(ctx, path, () => { others++ })
      await watcher.dispose()
      // The OS may still report the write above while the watch is live, so
      // only the calls after disposal count.
      const before = calls

      await touch(path, () => others > 0)
      expect(calls).to.equal(before)
    }, 15000)

    it('stops calling a listener once the calling fiber is disposed', async () => {
      const path = write('fiber.txt')
      const ctx = await setup()
      let calls = 0
      let others = 0
      const inner = await ctx.plugin({
        inject: ['fs'],
        apply: (ctx: Context) => {
          ctx.fs.watch(path).on('change', () => { calls++ })
        },
      })
      await watch(ctx, path, () => { others++ })
      await inner.dispose()
      const before = calls

      await touch(path, () => others > 0)
      expect(calls).to.equal(before)
    }, 15000)

    it('calls a `ready` listener added after the initial scan asynchronously', async () => {
      const path = write('ready.txt')
      const ctx = await setup()
      const watcher = await watch(ctx, path, () => {})
      let called = false
      watcher.on('ready', () => { called = true })

      expect(called).to.equal(false)
      await vi.waitFor(() => expect(called).to.equal(true))
    })

    it('calls a `ready` listener added by another one once', async () => {
      const path = write('ready-nested.txt')
      const ctx = await setup()
      const watcher = ctx.fs.watch(path)
      let calls = 0
      watcher.on('ready', () => {
        watcher.on('ready', () => { calls++ })
      })

      await vi.waitFor(() => expect(calls).to.equal(1))
      await new Promise(r => setTimeout(r, 50))
      expect(calls).to.equal(1)
    })

    it('does not call a listener removed by another one in the same dispatch', async () => {
      const path = write('removed.txt')
      const ctx = await setup()
      const watcher = ctx.fs.watch(path)
      let calls = 0
      watcher.on('ready', () => { remove() })
      const remove = watcher.on('ready', () => { calls++ })
      let others = 0
      watcher.on('ready', () => { others++ })

      await vi.waitFor(() => expect(others).to.equal(1))
      expect(calls).to.equal(0)
    })

    it('calls a function added again after its removal once for `ready`', async () => {
      const path = write('readded.txt')
      const ctx = await setup()
      const watcher = await watch(ctx, path, () => {})
      let calls = 0
      const listener = () => { calls++ }
      watcher.on('ready', listener)()
      watcher.on('ready', listener)

      await vi.waitFor(() => expect(calls).to.equal(1))
      await new Promise(r => setTimeout(r, 50))
      expect(calls).to.equal(1)
    })

    it('calls a function added again in the same dispatch once for `ready`', async () => {
      const path = write('readded-dispatch.txt')
      const ctx = await setup()
      const watcher = ctx.fs.watch(path)
      let calls = 0
      const listener = () => { calls++ }
      watcher.on('ready', () => {
        remove()
        watcher.on('ready', listener)
      })
      const remove = watcher.on('ready', listener)

      await vi.waitFor(() => expect(calls).to.equal(1))
      await new Promise(r => setTimeout(r, 50))
      expect(calls).to.equal(1)
    })

    describe('error', () => {
      let warnings: unknown[]

      async function setupWithWarnings() {
        const ctx = await setup()
        warnings = []
        ctx.logger.exporter({
          export(message) {
            if (message.type === 'warn') warnings.push(message.args[0])
          },
        })
        return ctx
      }

      // the chokidar watcher created by `ctx.fs.watch()`
      async function watchInternal(ctx: Context, path: string) {
        const add = vi.spyOn(FSWatcher.prototype, 'add')
        const watcher = await watch(ctx, path, () => {})
        const internal = add.mock.contexts[0] as FSWatcher
        add.mockRestore()
        return { watcher, internal }
      }

      it('logs an error of the watcher without an `error` listener', async () => {
        const ctx = await setupWithWarnings()
        const { internal } = await watchInternal(ctx, write('error/logged.txt'))

        const error = new Error('EPERM')
        expect(() => internal.emit('error', error)).to.not.throw()
        expect(warnings).to.include(error)
      })

      it('passes an error of the watcher to the `error` listeners instead of logging it', async () => {
        const ctx = await setupWithWarnings()
        const { watcher, internal } = await watchInternal(ctx, write('error/passed.txt'))
        const errors: unknown[] = []
        watcher.on('error', (error) => { errors.push(error) })

        const error = new Error('EPERM')
        internal.emit('error', error)
        await vi.waitFor(() => expect(errors).to.deep.equal([error]))
        expect(warnings).to.not.include(error)
      })

      it('passes an error of a `change` listener to the `error` listeners', async () => {
        const path = write('error/listener.txt')
        const ctx = await setupWithWarnings()
        const error = new Error('listener')
        const errors: unknown[] = []
        const watcher = await watch(ctx, path, () => { throw error })
        watcher.on('error', (error) => { errors.push(error) })

        await touch(path, () => errors.length)
        expect([...new Set(errors)]).to.deep.equal([error])
      }, 15000)

      it('logs an error of an `error` listener', async () => {
        const ctx = await setupWithWarnings()
        const { watcher, internal } = await watchInternal(ctx, write('error/nested.txt'))
        const error = new Error('error listener')
        watcher.on('error', () => { throw error })

        internal.emit('error', new Error('EPERM'))
        await vi.waitFor(() => expect(warnings).to.include(error))
      })

      it('does not call an `error` listener removed by another one in the same dispatch', async () => {
        const ctx = await setupWithWarnings()
        const { watcher, internal } = await watchInternal(ctx, write('error/removed.txt'))
        const errors: unknown[] = []
        watcher.on('error', () => { remove() })
        const remove = watcher.on('error', (error) => { errors.push(error) })
        let others = 0
        watcher.on('error', () => { others++ })

        internal.emit('error', new Error('EPERM'))
        await vi.waitFor(() => expect(others).to.equal(1))
        expect(errors).to.deep.equal([])
      })
    })
  })
})
