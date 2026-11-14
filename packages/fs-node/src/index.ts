import { AccessMode, BaseFs, FsError, Watcher } from '@cordisjs/fs'
import { Context } from 'cordis'
import { access, constants, FileHandle, lstat, open, rename, rmdir, stat, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Operation, toFsError } from './error.ts'
import { watchPath } from './watcher.ts'

// `C:` is relative to the current directory of drive C, which depends on the
// process. A separator after the colon names a location.
const driveRelative = /^[a-zA-Z]:(?![\\/])/

function invalidPath(url: URL, message: string, cause?: unknown) {
  return new FsError('InvalidPath', url, message, { cause })
}

function toPath(url: URL) {
  let filename: string
  try {
    filename = fileURLToPath(url)
  } catch (error) {
    throw invalidPath(url, `invalid file URL ${JSON.stringify(url.href)}`, error)
  }
  if (process.platform === 'win32' && driveRelative.test(filename)) {
    throw invalidPath(url, `expected an absolute path, got the drive-relative form ${JSON.stringify(filename)} from ${JSON.stringify(url.href)}`)
  }
  // A trailing separator is kept, so that `node:fs` rejects a non-directory with `ENOTDIR`.
  // The path is absolute, and URL parsing has removed the dot segments.
  return filename
}

const trailingSeparators = process.platform === 'win32' ? /[\\/]+$/ : /\/+$/

/**
 * The path of the entry that the last component of `filename` names, without
 * a trailing separator, so that a symbolic link there is not followed.
 */
function toEntry(filename: string) {
  const stripped = filename.replace(trailingSeparators, '')
  return filename.slice(0, Math.max(parse(filename).root.length, stripped.length))
}

// A trailing separator requires a directory, which a symbolic link may resolve to.
async function assertDirectory(entry: string, info: Stats, url: URL) {
  const target = info.isSymbolicLink() ? await stat(entry) : info
  if (!target.isDirectory()) {
    throw new FsError('NotADirectory', url, `expected a directory at ${url.href}`)
  }
}

/**
 * A location with a trailing separator names a directory, so an operation on
 * the content of a file fails there without I/O. The check is made here rather
 * than left to `node:fs`, which on Windows removes a trailing separator.
 */
function assertFile(filename: string, url: URL) {
  if (!trailingSeparators.test(filename)) return
  throw new FsError('IsADirectory', url, `expected a file at ${url.href}`)
}

async function run<T>(url: URL, operation: Operation, callback: (filename: string) => Promise<T>) {
  const filename = toPath(url)
  return call(url, operation, () => callback(filename))
}

// an error of `callback` is an error of the file system
async function call<T>(url: URL, operation: Operation, callback: () => Promise<T>) {
  try {
    return await callback()
  } catch (error) {
    throw toFsError(error, url, operation)
  }
}

const CHUNK_SIZE = 64 * 1024

/** The local file system of Node.js. */
class NodeFs extends BaseFs {
  constructor(ctx: Context, config: NodeFs.Config = {}) {
    super(ctx, { mount: config.mount ?? 'file:' })
  }

  read(url: URL): ReadableStream<Uint8Array> {
    const filename = toPath(url)
    // `cancel()` may be called before the file is opened, so it waits for the
    // opening instead of reading a handle assigned by `start()`
    let opening: Promise<FileHandle>
    let closing: Promise<void> | undefined
    const close = () => closing ??= opening.then(
      handle => call(url, 'read', () => handle.close()),
      () => {},
    )
    return new ReadableStream({
      start: async () => {
        opening = call(url, 'read', () => {
          assertFile(filename, url)
          return open(filename, 'r')
        })
        await opening
      },
      pull: async (controller) => {
        try {
          const handle = await opening
          const buffer = new Uint8Array(CHUNK_SIZE)
          const { bytesRead } = await call(url, 'read', () => handle.read(buffer, 0, CHUNK_SIZE, null))
          if (bytesRead) return controller.enqueue(buffer.subarray(0, bytesRead))
          await close()
          controller.close()
        } catch (error) {
          await close().catch(() => {})
          throw error
        }
      },
      cancel: async () => {
        await close()
      },
    })
  }

  async write(url: URL, body: ReadableStream<Uint8Array>) {
    const handle = await run(url, 'write', (filename) => {
      assertFile(filename, url)
      return open(filename, 'w')
    })
    try {
      // an error of `body` is kept as it is
      for await (const chunk of body) {
        for (let offset = 0; offset < chunk.byteLength;) {
          const { bytesWritten } = await call(url, 'write', () => handle.write(chunk, offset))
          offset += bytesWritten
        }
      }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
    await call(url, 'write', () => handle.close())
  }

  async access(url: URL, mode: AccessMode) {
    return run(url, 'access', async (filename) => {
      // `node:fs` on Windows removes a trailing separator
      const entry = toEntry(filename)
      if (entry !== filename) await assertDirectory(entry, await stat(entry), url)
      if (mode === 'write') await access(filename, constants.W_OK)
    })
  }

  async rename(src: URL, dest: URL) {
    const to = toPath(dest)
    return run(src, 'rename', async (from) => {
      const source = toEntry(from)
      const target = toEntry(to)
      if (source !== from || target !== to) {
        await assertDirectory(source, await stat(source), src)
      }
      await rename(source, target)
    })
  }

  async remove(url: URL) {
    return run(url, 'remove', async (filename) => {
      // a symbolic link in the last component is removed itself
      const entry = toEntry(filename)
      const info = await lstat(entry)
      if (entry !== filename) await assertDirectory(entry, info, url)
      if (info.isDirectory()) {
        await rmdir(entry)
      } else {
        await unlink(entry)
      }
    })
  }

  watch(watcher: Watcher) {
    // a watch of `dir/` is a watch of `dir`
    return watchPath(watcher, resolve(toPath(watcher.url)))
  }
}

namespace NodeFs {
  export interface Config {
    /** a scheme or a `file:` URL ending with `/`, `file:` by default */
    mount?: string
  }
}

export default NodeFs
