import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { watch } from 'chokidar'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

declare module 'cordis' {
  interface Context {
    fs: Fs
  }
}

export type WatchCallback = (filename: string) => Awaitable<void>

/** Resolves once the initial scan is done. Calling it ends the watch. */
export interface WatchHandle extends PromiseLike<() => Promise<void>> {
  (): Promise<void>
}

export interface WatchOptions {
  /** called with absolute paths */
  ignored?: (filename: string) => boolean
}

/** For now, fs only provides `watch()`, coupled to `node:fs` through chokidar. */
class Fs extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /** A relative path is resolved against the calling context. */
  private _resolve(path: string | URL) {
    if (path instanceof URL || path.startsWith('file:')) return fileURLToPath(path)
    if (isAbsolute(path)) return resolve(path)
    // resolved as a path rather than a URL, so that `#` and `%` stay literal
    if (this.ctx.baseUrl) return resolve(fileURLToPath(new URL('.', this.ctx.baseUrl)), path)
    return resolve(path)
  }

  /**
   * Watch a file or a directory. `callback` receives the absolute path of
   * each changed file. The watch ends with the calling fiber.
   */
  watch(path: string | URL, callback: WatchCallback, options: WatchOptions = {}): WatchHandle {
    const filename = this._resolve(path)
    // A file replaced through a rename, as by an atomic write, is lost by a
    // watch on the file itself, so its directory is watched instead.
    const isFile = !statSync(filename, { throwIfNoEntry: false })?.isDirectory()
    const root = isFile ? dirname(filename) : filename
    return this.ctx.effect(async () => {
      const watcher = watch(root, {
        ignoreInitial: true,
        depth: isFile ? 0 : undefined,
        ignored: (path) => {
          path = resolve(path)
          if (isFile && path !== root && path !== filename) return true
          return !!options.ignored?.(path)
        },
      })
      watcher.on('change', async (path) => {
        try {
          await callback(resolve(path))
        } catch (error) {
          this.ctx.logger.warn(error)
        }
      })
      await new Promise<void>(resolve => watcher.once('ready', () => resolve()))
      return () => watcher.close()
    }, 'ctx.fs.watch()')
  }
}

export default Fs
