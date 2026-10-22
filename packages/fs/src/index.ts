import { Context, Service } from 'cordis'
import { Awaitable } from 'cosmokit'
import { watch } from 'chokidar'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

declare module 'cordis' {
  interface Context {
    fs: Fs
  }
}

export type WatchCallback = (filename: string) => Awaitable<void>

// resolves once the initial scan is done
export interface WatchHandle extends PromiseLike<() => Promise<void>> {
  (): Promise<void>
}

export interface WatchOptions {
  // called with absolute paths
  ignored?: (filename: string) => boolean
}

// For now, fs only provides `watch()`, coupled to `node:fs` through chokidar.
class Fs extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  // A relative path is resolved against the calling context.
  private _resolve(path: string | URL) {
    if (path instanceof URL || path.startsWith('file:')) return fileURLToPath(path)
    if (isAbsolute(path)) return resolve(path)
    // resolved as a path rather than a URL, so that `#` and `%` stay literal
    if (this.ctx.baseUrl) return resolve(fileURLToPath(new URL('.', this.ctx.baseUrl)), path)
    return resolve(path)
  }

  // Watch a file or a directory. `callback` receives the absolute path of
  // each changed file. The watch ends with the calling fiber.
  watch(path: string | URL, callback: WatchCallback, options: WatchOptions = {}): WatchHandle {
    const filename = this._resolve(path)
    return this.ctx.effect(async () => {
      const watcher = watch(filename, {
        ignoreInitial: true,
        ignored: options.ignored && (path => options.ignored!(resolve(path))),
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
