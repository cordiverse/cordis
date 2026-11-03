import { Context } from 'cordis'
import { Awaitable } from 'cosmokit'
import { watch } from 'chokidar'
import { statSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import picomatch from 'picomatch'

export type WatchFilter = string[] | ((path: string, isDirectory: boolean) => boolean)

export interface WatchOptions {
  /**
   * Decides which entries below a watched directory are kept.
   */
  filter?: WatchFilter
}

export interface WatchEvents {
  /** A file below the watched path is modified. */
  change(filename: string): Awaitable<void>
  /** The initial scan is done. A listener added afterwards is called at once. */
  ready(): Awaitable<void>
  /** An error is logged as a warning without a listener. */
  error(error: unknown): Awaitable<void>
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

/** A subscription made by `on()`, apart from any other with the same listener */
interface Hook<F> {
  listener: F
  removed?: boolean
}

type Hooks = { [K in keyof WatchEvents]: Set<Hook<WatchEvents[K]>> }

export class Watcher {
  /** Ends the watch. The watch also ends with the calling fiber. */
  public dispose: () => Promise<void>

  private _hooks: Hooks = { change: new Set(), ready: new Set(), error: new Set() }
  private _ready = false

  constructor(private ctx: Context, filename: string, options: WatchOptions) {
    // A file replaced through a rename, as by an atomic write, is lost by a
    // watch on the file itself, so its directory is watched instead.
    const isFile = !statSync(filename, { throwIfNoEntry: false })?.isDirectory()
    const root = isFile ? dirname(filename) : filename
    const keep = options.filter && toPredicate(options.filter)
    // chokidar omits the stats in some calls, so the type found by an earlier call is kept.
    const isDirectoryMap = new Map<string, boolean>()
    this.dispose = ctx.effect(async () => {
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
      watcher.on('error', error => this._error(error))
      watcher.on('change', path => this._emit('change', resolve(path)))
      await new Promise<void>(resolve => watcher.once('ready', () => resolve()))
      this._ready = true
      this._emit('ready')
      return () => watcher.close()
    }, 'ctx.fs.watch()')
  }

  /** Adds a listener, and returns a function that removes it. */
  on<K extends keyof WatchEvents>(name: K, listener: WatchEvents[K]): () => void {
    const hooks = this._hooks[name] as Set<Hook<WatchEvents[K]>>
    const hook: Hook<WatchEvents[K]> = { listener }
    hooks.add(hook)
    if (name === 'ready' && this._ready) {
      // asynchronously, as a listener added before the scan is done
      queueMicrotask(() => {
        if (!hook.removed) this._call(listener, [])
      })
    }
    return () => {
      hook.removed = true
      hooks.delete(hook)
    }
  }

  // The hooks are taken when an event is dispatched, so that one added
  // meanwhile is not called for it, and a `ready` listener only once. One
  // removed meanwhile is not called either.
  private _emit<K extends keyof WatchEvents>(name: K, ...args: Parameters<WatchEvents[K]>) {
    for (const hook of [...this._hooks[name]]) {
      if (!hook.removed) this._call(hook.listener, args)
    }
  }

  private _call(listener: (...args: any[]) => Awaitable<void>, args: any[]) {
    (async () => listener(...args))().catch(error => this._error(error))
  }

  private _error(error: unknown) {
    const hooks = this._hooks.error
    if (!hooks.size) return this.ctx.logger.warn(error)
    for (const hook of [...hooks]) {
      if (hook.removed) continue
      // An error of an error listener is not reported to the error listeners again.
      (async () => hook.listener(error))().catch(error => this.ctx.logger.warn(error))
    }
  }
}
