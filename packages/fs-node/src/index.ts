import { Context, Service } from 'cordis'
import { access, constants, lstat, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FsError, toFsError } from './error.ts'
import { Watcher, WatchOptions } from './watcher.ts'

export * from './error.ts'
export * from './watcher.ts'

declare module 'cordis' {
  interface Context {
    fs: Fs
  }
}

export type AccessMode = 'write'

export interface RemoveOptions {
  /** A missing target is not an error. */
  force?: boolean
}

// `C:` is relative to the current directory of drive C, which depends on the
// process. A separator after the colon names a location.
const driveRelative = /^[a-zA-Z]:(?![\\/])/

function invalidPath(message: string, url?: URL, cause?: unknown) {
  return new FsError('InvalidPath', message, url, { cause })
}

// `value` is the path, and `source` the input it is decoded from
function assertPath(value: string, source: string) {
  const origin = value === source ? '' : ` from ${JSON.stringify(source)}`
  if (value.includes('\0')) {
    throw invalidPath(`expected a path without a NUL character, got ${JSON.stringify(value)}${origin}`)
  }
  if (process.platform === 'win32' && driveRelative.test(value)) {
    throw invalidPath(`expected an absolute path, got the drive-relative form ${JSON.stringify(value)}${origin}`)
  }
}

function parseUrl(input: string | URL) {
  if (input instanceof URL) return input
  try {
    return new URL(input)
  } catch (error) {
    throw invalidPath(`invalid URL ${JSON.stringify(input)}`, undefined, error)
  }
}

/** A reference to a file. Creating it performs no I/O. */
export class FileRef {
  constructor(public readonly url: URL, private filename: string) {}

  /** Reads the current content as UTF-8 text. */
  async text(): Promise<string> {
    try {
      return await readFile(this.filename, 'utf8')
    } catch (error) {
      throw toFsError(error, this.url, 'read')
    }
  }

  /** Replaces the content, creating the file if it is missing. The parent directory is not created. */
  async write(data: string): Promise<void> {
    try {
      await writeFile(this.filename, data)
    } catch (error) {
      throw toFsError(error, this.url, 'write')
    }
  }
}

/** For now, fs is coupled to `node:fs`, and to chokidar for `watch()`. */
class Fs extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /** A relative path is resolved against the calling context. The result is normalized. */
  private _resolve(path: string | URL) {
    if (path instanceof URL || path.startsWith('file:')) {
      const url = parseUrl(path)
      if (url.protocol !== 'file:') {
        throw new FsError('NotSupported', `no implementation handles ${JSON.stringify(url.href)}`, url)
      }
      if (url.search || url.hash) {
        throw invalidPath(`expected a file URL without a query or a fragment, got ${JSON.stringify(url.href)}`, url)
      }
      let filename: string
      try {
        filename = fileURLToPath(url)
      } catch (error) {
        throw invalidPath(`invalid file URL ${JSON.stringify(url.href)}`, url, error)
      }
      // checked on the decoded path, before `resolve()` makes a drive-relative path absolute
      assertPath(filename, url.href)
      // `fileURLToPath()` keeps a trailing slash
      return resolve(filename)
    }
    assertPath(path, path)
    if (isAbsolute(path)) return resolve(path)
    // resolved as a path rather than a URL, so that `#` and `%` stay literal
    if (this.ctx.baseUrl) return resolve(fileURLToPath(new URL('.', this.ctx.baseUrl)), path)
    return resolve(path)
  }

  /** Creates a reference to a file. The location is resolved now. */
  file(path: string | URL): FileRef {
    const filename = this._resolve(path)
    return new FileRef(pathToFileURL(filename), filename)
  }

  /**
   * Resolves unless the operation is known to be denied: a missing location
   * rejects with `NotFound`, and a denial by the storage with `PermissionDenied`.
   */
  async access(path: string | URL, mode: AccessMode): Promise<void> {
    const filename = this._resolve(path)
    try {
      if (mode === 'write') await access(filename, constants.W_OK)
    } catch (error) {
      throw toFsError(error, pathToFileURL(filename), 'access')
    }
  }

  /**
   * Renames an entry. An existing file at `dest` is replaced; a non-empty
   * directory fails with `DirectoryNotEmpty`.
   */
  async rename(src: string | URL, dest: string | URL): Promise<void> {
    const from = this._resolve(src)
    const to = this._resolve(dest)
    try {
      await rename(from, to)
    } catch (error) {
      throw toFsError(error, pathToFileURL(from), 'rename')
    }
  }

  /**
   * Removes a file or an empty directory. A symbolic link is removed itself,
   * and its target is not touched.
   */
  async remove(path: string | URL, options: RemoveOptions = {}): Promise<void> {
    const filename = this._resolve(path)
    try {
      const stats = await lstat(filename)
      if (stats.isDirectory()) {
        await rmdir(filename)
      } else {
        await unlink(filename)
      }
    } catch (error) {
      const result = toFsError(error, pathToFileURL(filename), 'remove')
      if (options.force && result instanceof FsError && result.code === 'NotFound') return
      throw result
    }
  }

  /** Watch a file or a directory. The watch ends with the calling fiber. */
  watch(path: string | URL, options: WatchOptions = {}): Watcher {
    return new Watcher(this.ctx, this._resolve(path), options)
  }
}

export default Fs
