import { Watcher, WatchFilter, WatchOptions } from '@cordisjs/fs'
import { Context } from 'cordis'
import { FSWatcher, watch } from 'chokidar'
import { statSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import picomatch from 'picomatch'

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

/** Watches a file or a directory through chokidar. */
export class NodeWatcher extends Watcher {
  private _watcher?: FSWatcher
  private _keep?: (path: string, isDirectory: boolean) => boolean

  constructor(ctx: Context, url: URL, options: WatchOptions, private filename: string) {
    super(ctx, url, options)
    this._keep = options.filter && toPredicate(options.filter)
  }

  protected _start() {
    const { filename } = this
    // A file replaced through a rename, as by an atomic write, is lost by a
    // watch on the file itself, so its directory is watched instead.
    const isFile = !statSync(filename, { throwIfNoEntry: false })?.isDirectory()
    const root = isFile ? dirname(filename) : filename
    const keep = this._keep
    const watcher = this._watcher = watch(root, {
      ignoreInitial: true,
      depth: isFile ? 0 : undefined,
      // chokidar also tests the root itself
      ignored: (path, stats) => {
        path = resolve(path)
        if (path === root) return false
        if (isFile) return path !== filename
        if (!keep) return false
        // Without the stats, or with the `lstat()` of a symbolic link, the type
        // is unknown, so the entry is kept; chokidar tests it again with the
        // stats of `stat()` before it is watched.
        if (!stats || stats.isSymbolicLink()) return false
        return !keep(relative(root, path).split(sep).join('/'), stats.isDirectory())
      },
    })
    watcher.on('error', error => this._error(error))
    watcher.on('change', path => this._emit('change', resolve(path)))
    return new Promise<void>(resolve => watcher.once('ready', () => resolve()))
  }

  protected _stop() {
    return this._watcher?.close()
  }
}
