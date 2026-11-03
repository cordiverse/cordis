import { Context, Fiber } from 'cordis'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FSWatcher } from 'chokidar'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Fs from '../src/index.ts'

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
      await ctx.fs.watch('__fixtures__/base with spaces # %/relative.txt', (filename) => { seen.push(filename) })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('resolves a relative path against the working directory without a context directory', async () => {
      const path = write('cwd.txt')
      const ctx = await setup(null)
      const seen: string[] = []
      await ctx.fs.watch(relative(process.cwd(), path), (filename) => { seen.push(filename) })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('accepts a file URL', async () => {
      const path = write('base with spaces # %/url.txt')
      const ctx = await setup()
      const seen: string[] = []
      await ctx.fs.watch(pathToFileURL(path).href, (filename) => { seen.push(filename) })

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
      await ctx.fs.watch(toUrl(dirname(path)), (filename) => { seen.push(filename) }, {
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
      await ctx.fs.watch(resolve(dir, basename(path)), () => { calls++ })

      await touch(path, () => calls > 0)
    }, 15000)
  })

  describe('watch', () => {
    // an atomic write replaces the file through a rename
    it('keeps watching a file replaced through renames', async () => {
      const path = write('atomic/config.yml')
      const sibling = write('atomic/sibling.yml')
      const ctx = await setup()
      const seen: string[] = []
      await ctx.fs.watch(path, (filename) => { seen.push(filename) })

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
      await ctx.fs.watch(resolve(fixture, 'dir'), (filename) => { seen.push(filename) })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('reports a file created after the watch starts', async () => {
      const path = resolve(fixture, 'created/file.txt')
      mkdirSync(dirname(path), { recursive: true })
      const ctx = await setup()
      const seen: string[] = []
      await ctx.fs.watch(path, (filename) => { seen.push(filename) })

      // The file is created afresh each time, so that only its creation can be
      // reported. A deletion is left to settle first, as chokidar reports a
      // file deleted and created again shortly after as a change.
      for (let i = 0; !seen.length; i++) {
        if (i >= 20) throw new Error('create timed out')
        rmSync(path, { force: true })
        await new Promise(r => setTimeout(r, 200))
        writeFileSync(path, '')
        await new Promise(r => setTimeout(r, 200))
      }
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('applies `filter` to each watch on its own', async () => {
      const kept = write('filtered/kept.txt')
      const claimed = write('filtered/.claimed.yml')
      const ctx = await setup()
      const fromDir: string[] = []
      const fromFile: string[] = []
      await ctx.fs.watch(resolve(fixture, 'filtered'), (filename) => { fromDir.push(filename) }, {
        filter: path => !path.startsWith('.'),
      })
      await ctx.fs.watch(claimed, (filename) => { fromFile.push(filename) })

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
      await ctx.fs.watch(resolve(fixture, 'relative'), (filename) => { seen.push(filename) }, {
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
      await ctx.fs.watch(resolve(fixture, 'glob'), (filename) => { seen.push(filename) }, {
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
      await ctx.fs.watch(resolve(fixture, 'ordered'), (filename) => { seen.push(filename) }, {
        filter: ['src', '!src/gen', 'src/gen/keep.ts'],
      })

      await touch([...selected, ...others], () => selected.every(path => seen.includes(path)))
      await new Promise(r => setTimeout(r, 200))
      expect([...new Set(seen)].sort()).to.deep.equal(selected.sort())
    }, 15000)

    it('keeps no entry with an empty `filter`', async () => {
      const path = write('empty/file.txt')
      const ctx = await setup()
      const seen: string[] = []
      const fromFile: string[] = []
      await ctx.fs.watch(resolve(fixture, 'empty'), (filename) => { seen.push(filename) }, { filter: [] })
      await ctx.fs.watch(path, (filename) => { fromFile.push(filename) })

      await touch(path, () => fromFile.length)
      await new Promise(r => setTimeout(r, 200))
      expect(seen).to.deep.equal([])
    }, 15000)

    it('rejects a `filter` entry leading outside the watched directory', async () => {
      const ctx = await setup()
      for (const entry of ['../outside', '!../outside', 'a/../../outside', '/absolute']) {
        expect(() => ctx.fs.watch(fixture, () => {}, { filter: [entry] })).to.throw(TypeError)
      }
    })

    it('does not apply `filter` to the watched directory', async () => {
      const path = write('.root/file.txt')
      const ctx = await setup()
      const seen: string[] = []
      await ctx.fs.watch(resolve(fixture, '.root'), (filename) => { seen.push(filename) }, {
        filter: ['.', '!**/.*'],
      })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('does not apply `filter` to a watched file', async () => {
      const path = write('.parent/.file')
      const ctx = await setup()
      const seen: string[] = []
      await ctx.fs.watch(path, (filename) => { seen.push(filename) }, { filter: [] })

      await touch(path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([path])
    }, 15000)

    it('runs every callback registered for the same path', async () => {
      const path = write('shared.txt')
      const ctx = await setup()
      const seen: string[] = []
      await ctx.fs.watch(path, () => { seen.push('a') })
      await ctx.fs.watch(path, () => { seen.push('b') })

      await touch(path, () => seen.length >= 2)
      expect([...new Set(seen)].sort()).to.deep.equal(['a', 'b'])
    }, 15000)

    it('stops calling a callback once it is disposed', async () => {
      const path = write('dispose.txt')
      const ctx = await setup()
      let calls = 0
      let others = 0
      const dispose = await ctx.fs.watch(path, () => { calls++ })
      await ctx.fs.watch(path, () => { others++ })
      await dispose()
      // The OS may still report the write above while the watch is live, so
      // only the calls after disposal count.
      const before = calls

      await touch(path, () => others > 0)
      expect(calls).to.equal(before)
    }, 15000)

    it('logs an error of the watcher instead of throwing it', async () => {
      const path = write('error.txt')
      const ctx = await setup()
      const warnings: unknown[] = []
      ctx.logger.exporter({
        export(message) {
          if (message.type === 'warn') warnings.push(message.args[0])
        },
      })
      const add = vi.spyOn(FSWatcher.prototype, 'add')
      await ctx.fs.watch(path, () => {})
      const watcher = add.mock.contexts[0] as FSWatcher
      add.mockRestore()

      const error = new Error('EPERM')
      expect(() => watcher.emit('error', error)).to.not.throw()
      expect(warnings).to.include(error)
    })
  })
})
