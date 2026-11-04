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

// `C:` is relative to the current directory of drive C, which depends on the
// process. A separator after the colon names a location.
const driveRelative = /^[a-zA-Z]:(?![\\/])/

function assertNotDriveRelative(value: string, source: string) {
  if (process.platform !== 'win32' || !driveRelative.test(value)) return
  const origin = value === source ? '' : ` from ${JSON.stringify(source)}`
  throw new TypeError(
    `expected an absolute path, got the drive-relative form ${JSON.stringify(value)}${origin}`,
  )
}

/** For now, fs only provides `watch()`, coupled to `node:fs` through chokidar. */
class Fs extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /** A relative path is resolved against the calling context. The result is normalized. */
  private _resolve(path: string | URL) {
    if (path instanceof URL || path.startsWith('file:')) {
      // checked before `resolve()`, which makes a drive-relative path absolute
      const filename = fileURLToPath(path)
      assertNotDriveRelative(filename, String(path))
      // `fileURLToPath()` keeps a trailing slash
      return resolve(filename)
    }
    assertNotDriveRelative(path, path)
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
