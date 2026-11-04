import { AccessMode, BaseFs, FsError, Watcher } from '@cordisjs/fs'
import { access, constants, FileHandle, lstat, open, rename, rmdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
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
  // checked before `resolve()`, which makes a drive-relative path absolute
  if (process.platform === 'win32' && driveRelative.test(filename)) {
    throw invalidPath(url, `expected an absolute path, got the drive-relative form ${JSON.stringify(filename)} from ${JSON.stringify(url.href)}`)
  }
  // `fileURLToPath()` keeps a trailing slash
  return resolve(filename)
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
  static mount = 'file:'

  read(url: URL): ReadableStream<Uint8Array> {
    const filename = toPath(url)
    let handle: FileHandle | undefined
    const close = () => {
      const current = handle
      handle = undefined
      return current && call(url, 'read', () => current.close())
    }
    return new ReadableStream({
      start: async () => {
        handle = await call(url, 'read', () => open(filename, 'r'))
      },
      pull: async (controller) => {
        try {
          const buffer = new Uint8Array(CHUNK_SIZE)
          const { bytesRead } = await call(url, 'read', () => handle!.read(buffer, 0, CHUNK_SIZE, null))
          if (bytesRead) return controller.enqueue(buffer.subarray(0, bytesRead))
          await close()
          controller.close()
        } catch (error) {
          await close()?.catch(() => {})
          throw error
        }
      },
      cancel: async () => {
        await close()
      },
    })
  }

  async write(url: URL, body: ReadableStream<Uint8Array>) {
    const handle = await run(url, 'write', filename => open(filename, 'w'))
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
      if (mode === 'write') await access(filename, constants.W_OK)
    })
  }

  async rename(src: URL, dest: URL) {
    const to = toPath(dest)
    return run(src, 'rename', from => rename(from, to))
  }

  async remove(url: URL) {
    return run(url, 'remove', async (filename) => {
      const stats = await lstat(filename)
      if (stats.isDirectory()) {
        await rmdir(filename)
      } else {
        await unlink(filename)
      }
    })
  }

  watch(watcher: Watcher) {
    return watchPath(watcher, toPath(watcher.url))
  }
}

export default NodeFs
