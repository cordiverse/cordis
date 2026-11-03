import { Context, Service } from 'cordis'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Watcher, WatchOptions } from './watcher.ts'

export * from './watcher.ts'

declare module 'cordis' {
  interface Context {
    fs: Fs
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

  /** Watch a file or a directory. The watch ends with the calling fiber. */
  watch(path: string | URL, options: WatchOptions = {}): Watcher {
    return new Watcher(this.ctx, this._resolve(path), options)
  }
}

export default Fs
