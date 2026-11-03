import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { watch } from 'chokidar'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'

declare module 'cordis' {
  interface Context {
    fs: Fs
  }
}

export type WatchCallback = (filename: string) => Awaitable<void>

export type WatchFilter = string[] | ((path: string, isDirectory: boolean) => boolean)

/** Resolves once the initial scan is done. Calling it ends the watch. */
export interface WatchHandle extends PromiseLike<() => Promise<void>> {
  (): Promise<void>
}

export interface WatchOptions {
  /**
   * Decides which entries below a watched directory are kept.
   */
  filter?: WatchFilter
}

// whether `path` is `base` or lies below it
function contains(base: string, path: string) {
  return !base || path === base || path.startsWith(base + '/')
}

// whether `match` matches `path` or one of its ancestors
function matchesUpward(match: (path: string) => boolean, path: string) {
  for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
    if (match(path.slice(0, end))) return true
  }
  return false
}

interface Rule {
  negated: boolean
  match: (path: string) => boolean
  /** the directory before the first glob segment, empty for the watched directory */
  base: string
  /** whether the ancestors of an entry are tested */
  upward: boolean
}

function toPredicate(filter: WatchFilter): (path: string, isDirectory: boolean) => boolean {
  if (typeof filter === 'function') return filter
  const rules = filter.map<Rule>((entry) => {
    const negated = entry.startsWith('!')
    const pattern = posix.normalize(negated ? entry.slice(1) : entry).replace(/\/$/, '')
    if (posix.isAbsolute(pattern) || pattern.split('/').includes('..')) {
      throw new TypeError(`filter entry ${JSON.stringify(entry)} leads outside the watched directory`)
    }
    // compared with real paths, so the escapes are removed
    const { base } = picomatch.scan(pattern, { unescape: true })
    return {
      negated,
      // `.` is the watched directory, which no path below it matches.
      // `posix` makes `[!...]` a negated bracket expression, as in POSIX.
      match: pattern === '.' ? () => true : picomatch(pattern, { posix: true }),
      base: base === '.' ? '' : base,
      upward: true,
    }
  })
  // Below an entry excluded with no including pattern after it, no entry is
  // reached, so the ancestors need not be tested.
  for (let index = rules.length - 1; index >= 0 && rules[index].negated; index--) {
    rules[index].upward = false
  }
  return (path, isDirectory) => {
    // The last pattern that matches the entry or one of its ancestors decides.
    let index = rules.length
    while (index--) {
      const { match, upward } = rules[index]
      if (upward ? matchesUpward(match, path) : match(path)) break
    }
    if (index >= 0 && !rules[index].negated) return true
    // A directory is kept if a later including pattern may lead below it.
    return isDirectory && rules.some(({ negated, base }, i) => {
      return i > index && !negated && (contains(base, path) || contains(path, base))
    })
  }
}

/** For now, fs only provides `watch()`, coupled to `node:fs` through chokidar. */
class Fs extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /** A relative path is resolved against the calling context. The result is normalized. */
  private _resolve(path: string | URL) {
    // `fileURLToPath()` keeps a trailing slash
    if (path instanceof URL || path.startsWith('file:')) return resolve(fileURLToPath(path))
    if (isAbsolute(path)) return resolve(path)
    // resolved as a path rather than a URL, so that `#` and `%` stay literal
    if (this.ctx.baseUrl) return resolve(fileURLToPath(new URL('.', this.ctx.baseUrl)), path)
    return resolve(path)
  }

  /**
   * Watch a file or a directory. `callback` receives the absolute path of
   * each changed or added file. The watch ends with the calling fiber.
   */
  watch(path: string | URL, callback: WatchCallback, options: WatchOptions = {}): WatchHandle {
    const filename = this._resolve(path)
    // A file replaced through a rename, as by an atomic write, is lost by a
    // watch on the file itself, so its directory is watched instead.
    const isFile = !statSync(filename, { throwIfNoEntry: false })?.isDirectory()
    const root = isFile ? dirname(filename) : filename
    const keep = options.filter && toPredicate(options.filter)
    // chokidar omits the stats in some calls, so the type found by an earlier call is kept.
    const isDirectoryMap = new Map<string, boolean>()
    return this.ctx.effect(async () => {
      const watcher = watch(root, {
        ignoreInitial: true,
        depth: isFile ? 0 : undefined,
        // chokidar also tests the root itself
        ignored: (path, stats) => {
          path = resolve(path)
          if (path === root) return false
          if (isFile) return path !== filename
          if (!keep) return false
          // The stats of a symbolic link, from `lstat()` in a scan, do not tell
          // the type of its target, which a later call with `stat()` does. A
          // type known before, as of a file the link replaced, is dropped.
          if (stats?.isSymbolicLink()) {
            isDirectoryMap.delete(path)
          } else if (stats) {
            isDirectoryMap.set(path, stats.isDirectory())
          }
          const isDirectory = isDirectoryMap.get(path)
          // decided by a later call with the stats
          if (isDirectory === undefined) return false
          return !keep(relative(root, path).split(sep).join('/'), isDirectory)
        },
      })
      watcher.on('error', (error) => {
        this.ctx.logger.warn(error)
      })
      const listener = async (path: string) => {
        try {
          await callback(resolve(path))
        } catch (error) {
          this.ctx.logger.warn(error)
        }
      }
      watcher.on('add', listener)
      watcher.on('change', listener)
      await new Promise<void>(resolve => watcher.once('ready', () => resolve()))
      return () => watcher.close()
    }, 'ctx.fs.watch()')
  }
}

export default Fs
