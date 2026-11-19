import { AccessMode, BaseFs, EntryType, FsError, Stats as FsStats, Watcher, WriteOptions } from '@cordisjs/fs'
import { Context } from 'cordis'
import {
  access, constants, copyFile, FileHandle, lstat, mkdir, open, opendir,
  readlink, rename, rm, rmdir, stat, symlink, unlink,
} from 'node:fs/promises'
import type { BigIntStats, Dirent, Stats } from 'node:fs'
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path'
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
async function assertDirectory(entry: string, info: Stats | BigIntStats, url: URL) {
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

function getType(info: BigIntStats | Dirent): EntryType {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  if (info.isSymbolicLink()) return 'symlink'
  return 'other'
}

function toStats(info: BigIntStats): FsStats {
  return {
    type: getType(info),
    size: Number(info.size),
    mtime: info.mtime,
    mode: Number(info.mode & 0o7777n),
    ino: info.ino,
    dev: info.dev,
  }
}

const CHUNK_SIZE = 64 * 1024

/** The number of links that a copy follows at its destination, as `SYMLOOP_MAX` of Linux. */
const MAX_LINKS = 40

/**
 * The location that a link at `filename` points to, or `undefined` for an
 * entry that is not a link. A relative target is appended to the directory of
 * the link as stored, so that the file system resolves its components, a link
 * before a following `..` included, and keeps a trailing separator.
 */
async function followLink(filename: string) {
  const target = await readlink(filename).catch((error) => {
    if (error?.code !== 'EINVAL') throw error
  })
  if (target === undefined || isAbsolute(target)) return target
  const directory = dirname(filename)
  // a root such as `/` already ends with a separator
  return directory.endsWith(sep) ? directory + target : directory + sep + target
}

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

  async write(url: URL, body: ReadableStream<Uint8Array>, options: WriteOptions = {}) {
    const { mode } = options
    const handle = await run(url, 'write', (filename) => {
      assertFile(filename, url)
      return open(filename, 'w', mode)
    })
    try {
      // before the content and without the umask, as `copyFile()` gives it
      if (mode !== undefined) await call(url, 'write', () => handle.chmod(mode))
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

  async remove(url: URL, options: { recursive: boolean }) {
    return run(url, 'remove', async (filename) => {
      // a symbolic link in the last component is removed itself
      const entry = toEntry(filename)
      const info = await lstat(entry)
      if (entry !== filename) await assertDirectory(entry, info, url)
      if (!info.isDirectory()) {
        await unlink(entry)
      } else if (options.recursive) {
        // `rm()` removes the links below the directory without following them
        await rm(entry, { recursive: true })
      } else {
        await rmdir(entry)
      }
    })
  }

  async stat(url: URL, options: { follow: boolean }) {
    return run(url, 'stat', async (filename) => {
      // `node:fs` on Windows removes a trailing separator
      const entry = toEntry(filename)
      if (entry !== filename) {
        // a trailing separator follows a link in the last component
        const info = await stat(entry, { bigint: true })
        await assertDirectory(entry, info, url)
        return toStats(info)
      }
      return toStats(options.follow ? await stat(entry, { bigint: true }) : await lstat(entry, { bigint: true }))
    })
  }

  async* readdir(url: URL) {
    const filename = toPath(url)
    const dir = await call(url, 'readdir', () => opendir(filename))
    try {
      while (true) {
        const dirent = await call(url, 'readdir', () => dir.read())
        if (!dirent) return
        // `node:fs` obtains through `lstat()` a type that the file system does not report
        yield { name: dirent.name, type: getType(dirent) }
      }
    } finally {
      await dir.close().catch(() => {})
    }
  }

  async mkdir(url: URL, options: { recursive: boolean }) {
    return run(url, 'mkdir', async (filename) => {
      // An existing directory, also through a link, is not an error of a
      // recursive creation, while `node:fs` reports an existing file with `EEXIST`.
      await mkdir(filename, { recursive: options.recursive })
    })
  }

  // `copyFile()` clones the file where the file system supports it, and gives
  // the destination the permission bits of the source.
  async copy(src: URL, dest: URL, options: { overwrite: boolean }) {
    const from = toPath(src)
    let to = toPath(dest)
    assertFile(from, src)
    assertFile(to, dest)
    const flags = constants.COPYFILE_FICLONE | (options.overwrite ? 0 : constants.COPYFILE_EXCL)
    for (let count = 0; ; count++) {
      try {
        return await copyFile(from, to, flags)
      } catch (error: any) {
        let info: Stats | undefined
        let failure: any
        try {
          info = await stat(to)
        } catch (cause) {
          failure = cause
        }
        // a directory at the destination is reported as `EEXIST` with `COPYFILE_EXCL`, and as `EPERM` on Windows
        if (info?.isDirectory()) {
          throw new FsError('IsADirectory', dest, `cannot copy ${src.href} onto the directory ${dest.href}`, { cause: error })
        }
        if (error?.code !== 'EEXIST') throw toFsError(error, src, 'copy')
        // An entry exists, which `stat()` misses only as a dangling link; any
        // other failure, such as a loop of links, is that of the destination.
        if (failure && failure.code !== 'ENOENT') throw toFsError(failure, dest, 'copy')
        // the exclusive creation does not follow a dangling link, which has no content to replace
        const next = !info && count < MAX_LINKS ? await call(dest, 'copy', () => followLink(to)) : undefined
        if (next === undefined) {
          throw new FsError('AlreadyExists', dest, `cannot copy ${src.href} onto the existing ${dest.href}`, { cause: error })
        }
        to = next
      }
    }
  }

  async symlink(target: string, url: URL) {
    return run(url, 'symlink', async (filename) => {
      const entry = toEntry(filename)
      if (entry !== filename) {
        // A trailing separator names a directory, which a link is not.
        // `node:fs` on Windows would remove the separator.
        await lstat(entry)
        throw new FsError('AlreadyExists', url, `an entry exists at ${url.href}`)
      }
      try {
        // the type of the link is detected from the target on Windows
        await symlink(target, entry)
      } catch (error) {
        // A link to a directory requires a privilege on Windows, which a
        // junction does not. A junction stores the absolute target.
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        const info = await stat(resolve(dirname(entry), target)).catch(() => undefined)
        if (info?.isDirectory()) return symlink(target, entry, 'junction')
        // Without the file-link privilege Windows may report EPERM even when the link name is occupied.
        if (await lstat(entry).catch(() => undefined)) {
          throw new FsError('AlreadyExists', url, `an entry exists at ${url.href}`, { cause: error })
        }
        throw error
      }
    })
  }

  async readlink(url: URL) {
    return run(url, 'readlink', async (filename) => {
      const entry = toEntry(filename)
      if (entry !== filename) {
        // a trailing separator names the directory that a link resolves to
        await assertDirectory(entry, await stat(entry), url)
        throw new FsError('NotALink', url, `expected a symbolic link at ${url.href}`)
      }
      return readlink(entry)
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
