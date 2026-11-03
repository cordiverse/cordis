import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { watch } from 'chokidar'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'

declare module 'cordis' {
  interface Context {
    fs: Fs
  }
}

export type WatchCallback = (filename: string) => Awaitable<void>

export type WatchIgnored = string[] | ((path: string) => boolean)

/** Resolves once the initial scan is done. Calling it ends the watch. */
export interface WatchHandle extends PromiseLike<() => Promise<void>> {
  (): Promise<void>
}

export interface WatchOptions {
  /**
   * Entries below a watched directory to exclude, as glob patterns or as a
   * predicate. An entry is given by its path relative to the watched
   * directory, separated by `/`. Patterns are matched by picomatch.
   */
  ignored?: WatchIgnored
}

function toPredicate(ignored: WatchIgnored = []): (path: string) => boolean {
  if (typeof ignored === 'function') return ignored
  return picomatch(ignored, { posix: true })
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
    const ignored = toPredicate(options.ignored)
    return this.ctx.effect(async () => {
      const watcher = watch(root, {
        ignoreInitial: true,
        depth: isFile ? 0 : undefined,
        // chokidar also tests the root itself
        ignored: (path) => {
          path = resolve(path)
          if (path === root) return false
          if (isFile) return path !== filename
          return ignored(relative(root, path).split(sep).join('/'))
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
