import {
  AccessMode, BaseFs, EntryType, FsError, FsProvider, Stats as FsStats,
  ReadlinkResult, ReadOptions, ReadResult, RealpathResult, Watcher, WriteOptions, WriteResult,
} from '@cordisjs/fs'
import { Context } from 'cordis'
import {
  access, constants, copyFile, lstat, mkdir, open, opendir,
  readlink, realpath, rename, rm, rmdir, stat, symlink, unlink,
} from 'node:fs/promises'
import type { BigIntStats, Dirent, Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

// The version of a file: a fingerprint of the metadata that a change of
// the content updates. The change time detects a modification time restored
// after a change, and also changes with the permissions of the file.
function toVersion(info: BigIntStats) {
  return `${info.dev}-${info.ino}-${info.mtimeNs}-${info.ctimeNs}-${info.size}`
}

function toStats(info: BigIntStats): FsStats {
  const stats: FsStats = {
    type: getType(info),
    size: Number(info.size),
    mtime: info.mtime,
    mode: Number(info.mode & 0o7777n),
    ino: info.ino,
    dev: info.dev,
  }
  if (stats.type === 'file') stats.version = toVersion(info)
  return stats
}

function mismatch(url: URL, ifMatch: string, found: string, cause?: unknown) {
  return new FsError('VersionMismatch', url, `expected a file of version ${JSON.stringify(ifMatch)} at ${url.href}, found ${found}`, { cause })
}

// Fails unless the opened entry is a file of the version `ifMatch`.
function matchFile(url: URL, info: BigIntStats, ifMatch: string) {
  if (!info.isFile()) throw mismatch(url, ifMatch, info.isDirectory() ? 'a directory' : 'an entry of another type')
  const version = toVersion(info)
  if (version !== ifMatch) throw mismatch(url, ifMatch, `version ${JSON.stringify(version)}`)
}

/**
 * The flag of a conditional opening, which does not wait for the other end
 * of a FIFO: a reading succeeds, and a writing fails with `ENXIO`. The type
 * of the entry is then checked on the handle. Windows has no such entries.
 */
const nonblock = process.platform === 'win32' ? 0 : constants.O_NONBLOCK

// opens the file of a conditional write, which is neither created nor truncated
async function openMatching(filename: string, url: URL, ifMatch: string) {
  let handle: FileHandle
  try {
    handle = await open(filename, constants.O_WRONLY | nonblock)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw mismatch(url, ifMatch, 'no entry', error)
    if (code === 'ENXIO') throw mismatch(url, ifMatch, 'an entry of another type', error)
    if (code === 'EISDIR') throw mismatch(url, ifMatch, 'a directory', error)
    throw toFsError(error, url, 'write')
  }
  try {
    matchFile(url, await handle.stat({ bigint: true }), ifMatch)
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    throw toFsError(error, url, 'write')
  }
}

const CHUNK_SIZE = 64 * 1024

// The location of the target of the link at `filename`. On POSIX, a relative
// target is appended to the directory of the link as stored, so that the file
// system resolves its components, a link before a following `..` included.
// Windows resolves `..` before the links, and a rooted target on the volume
// of the link, as `resolve()` does.
function linkTarget(filename: string, target: string) {
  if (process.platform === 'win32') return resolve(dirname(filename), target)
  if (isAbsolute(target)) return target
  const directory = dirname(filename)
  // a root such as `/` already ends with a separator
  return directory.endsWith(sep) ? directory + target : directory + sep + target
}

// A path read from the file system as bytes, which a name that is not valid
// UTF-8 would change when decoded, so that it names another entry.
function decodePath(bytes: Buffer, url: URL) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (cause) {
    throw new FsError('InvalidPath', url, `cannot represent a path below ${url.href}, which is not valid UTF-8`, { cause })
  }
}

/** The number of links that `realpath()` follows to a missing entry, as `SYMLOOP_MAX` of Linux. */
const MAX_LINKS = 40

/** The local file system of Node.js. */
class NodeFs extends BaseFs {
  readonly capabilities: FsProvider.Capabilities = {
    range: 'unsigned',
    exclusive: true,
    conditional: { stat: true, read: true, write: true },
  }

  constructor(ctx: Context, config: NodeFs.Config = {}) {
    super(ctx, { mount: config.mount ?? 'file:' })
  }

  // The version is checked on the handle that the stream reads.
  async read(url: URL, { start = 0, end = Infinity, ifMatch }: ReadOptions = {}): Promise<ReadResult> {
    const filename = toPath(url)
    assertFile(filename, url)
    const opening = call(url, 'read', () => open(filename, ifMatch === undefined ? 'r' : constants.O_RDONLY | nonblock))
    let closing: Promise<void> | undefined
    const close = () => closing ??= opening.then(
      handle => call(url, 'read', () => handle.close()),
      () => {},
    )
    // the metadata of the opened file, if it has been queried for a version
    let checked: BigIntStats | undefined
    if (ifMatch !== undefined) {
      try {
        const handle = await opening.catch((error) => {
          throw error instanceof FsError && error.code === 'IsADirectory' ? mismatch(url, ifMatch, 'a directory', error) : error
        })
        checked = await call(url, 'read', () => handle.stat({ bigint: true }))
        matchFile(url, checked, ifMatch)
      } catch (error) {
        await close().catch(() => {})
        throw error
      }
    }
    let offset = 0
    let positioned = false
    const stream = new ReadableStream({
      async start(controller) {
        const handle = await opening
        if (start === 0 && end > 0) return
        try {
          // Empty ranges still reject directories. A nonzero start seeks in a
          // regular file and skips bytes sequentially in a FIFO.
          const info = checked ?? await call(url, 'read', () => handle.stat())
          if (info.isDirectory()) throw new FsError('IsADirectory', url, `is a directory: ${url.href}`)
          if (end <= start) {
            await close()
            controller.close()
          } else if (info.isFile()) {
            positioned = true
            offset = start
          }
        } catch (error) {
          await close().catch(() => {})
          throw error
        }
      },
      async pull(controller) {
        try {
          const handle = await opening
          while (offset < end) {
            const buffer = new Uint8Array(Math.min(CHUNK_SIZE, end - offset))
            const { bytesRead } = await call(url, 'read', () => handle.read(buffer, 0, buffer.length, positioned ? offset : null))
            if (!bytesRead) break
            const from = Math.max(0, start - offset)
            offset += bytesRead
            if (from < bytesRead) {
              controller.enqueue(buffer.subarray(from, bytesRead))
              if (offset < end) return
            }
          }
          await close()
          controller.close()
        } catch (error) {
          await close().catch(() => {})
          throw error
        }
      },
      cancel: close,
    }, { highWaterMark: 0 })
    return { stream }
  }

  // A conditional write opens the existing file without truncating it,
  // checks its version on the handle, and truncates it then.
  async write(url: URL, body: ReadableStream<Uint8Array>, { mode, exclusive, ifMatch }: WriteOptions): Promise<WriteResult> {
    const filename = toPath(url)
    assertFile(filename, url)
    const handle = ifMatch === undefined
      ? await call(url, 'write', () => open(filename, exclusive ? 'wx' : 'w', mode))
      : await openMatching(filename, url, ifMatch)
    try {
      // before the content and without the umask, as `copyFile()` gives it
      if (mode !== undefined) await call(url, 'write', () => handle.chmod(mode))
      if (ifMatch !== undefined) await call(url, 'write', () => handle.truncate(0))
      // an error of `body` is kept as it is
      // A failed write must be able to close its handle even if cancelling
      // the input waits for another consumer of a tee branch.
      for await (const chunk of body.values({ preventCancel: true })) {
        for (let offset = 0; offset < chunk.byteLength;) {
          const { bytesWritten } = await call(url, 'write', () => handle.write(chunk, offset))
          offset += bytesWritten
        }
      }
      await call(url, 'write', () => handle.close())
    } catch (error) {
      body.cancel(error).catch(() => {})
      const created = exclusive ? await handle.stat({ bigint: true }).catch(() => undefined) : undefined
      await handle.close().catch(() => {})
      if (created) {
        const entry = await lstat(filename, { bigint: true }).catch(() => undefined)
        if (entry?.dev === created.dev && entry.ino === created.ino) await unlink(filename).catch(() => {})
      }
      throw error
    }
    return {}
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
  async copy(src: URL, dest: URL, options: { exclusive: boolean }) {
    const from = toPath(src)
    const to = toPath(dest)
    assertFile(from, src)
    assertFile(to, dest)
    const flags = constants.COPYFILE_FICLONE | (options.exclusive ? constants.COPYFILE_EXCL : 0)
    try {
      await copyFile(from, to, flags)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Windows reports a directory at the destination as `EPERM`
      if (process.platform === 'win32' && code === 'EPERM' && (await stat(to).catch(() => undefined))?.isDirectory()) {
        throw new FsError('IsADirectory', dest, `is a directory: ${dest.href}`, { cause: error })
      }
      throw toFsError(error, code === 'EEXIST' ? dest : src, 'copy')
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

  async readlink(url: URL): Promise<ReadlinkResult> {
    const target = await run(url, 'readlink', async (filename) => {
      const entry = toEntry(filename)
      if (entry !== filename) {
        // a trailing separator names the directory that a link resolves to
        await assertDirectory(entry, await stat(entry), url)
        throw new FsError('NotALink', url, `expected a symbolic link at ${url.href}`)
      }
      return decodePath(await readlink(entry, { encoding: 'buffer' }), url)
    })
    return { target }
  }

  // The system resolves an existing entry, with its limit of links and the
  // directory that a trailing separator requires. A missing entry, or the
  // target of a dangling link, is located by following the links of the last
  // component here: the file system resolves the other components, and
  // `realpath()` of `node:fs` the directory of the missing entry.
  async realpath(url: URL): Promise<RealpathResult> {
    const resolved = await run(url, 'realpath', async (filename) => {
      try {
        const info = await stat(filename)
        // `node:fs` on Windows removes a trailing separator
        if (trailingSeparators.test(filename) && !info.isDirectory()) {
          throw new FsError('NotADirectory', url, `expected a directory at ${url.href}`)
        }
        return pathToFileURL(decodePath(await realpath(filename, { encoding: 'buffer' }), url))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      let entry = toEntry(filename)
      let directory = trailingSeparators.test(filename)
      for (let links = 0; ; links++) {
        const info = await lstat(entry).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        if (info?.isSymbolicLink()) {
          if (links === MAX_LINKS) throw new FsError('InvalidPath', url, `too many symbolic links at ${url.href}`)
          const target = decodePath(await readlink(entry, { encoding: 'buffer' }), url)
          if (trailingSeparators.test(target)) directory = true
          entry = toEntry(linkTarget(entry, target))
          continue
        }
        // an entry created since the first query
        if (info) {
          if (directory && !info.isDirectory()) throw new FsError('NotADirectory', url, `expected a directory at ${url.href}`)
          return pathToFileURL(decodePath(await realpath(entry, { encoding: 'buffer' }), url))
        }
        const parent = decodePath(await realpath(dirname(entry), { encoding: 'buffer' }), url)
        // a trailing separator names a directory
        const name = basename(entry) + (directory ? sep : '')
        return pathToFileURL(parent.endsWith(sep) ? parent + name : parent + sep + name)
      }
    })
    return { url: resolved }
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
