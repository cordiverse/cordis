import { FsError } from '@cordisjs/fs'

export type Operation = 'read' | 'write' | 'access' | 'rename' | 'remove'

/**
 * The code is determined by the error of `node:fs` and the operation alone, so
 * that classifying an error performs no further I/O.
 */
function getCode(code: string, operation: Operation): FsError.Code {
  switch (code) {
    case 'ENOENT': return 'NotFound'
    // POSIX allows `rmdir()` and `rename()` to report a non-empty directory with `EEXIST`
    case 'EEXIST': return operation === 'remove' || operation === 'rename' ? 'DirectoryNotEmpty' : 'AlreadyExists'
    case 'ENOTDIR': return 'NotADirectory'
    case 'EISDIR': return 'IsADirectory'
    case 'ENOTEMPTY': return 'DirectoryNotEmpty'
    case 'EPERM':
      // libuv reports `ERROR_ACCESS_DENIED` as `EPERM`, which for these
      // operations is most often an entry held open by another process
      if (process.platform === 'win32' && operation !== 'read' && operation !== 'access') return 'Busy'
      return 'PermissionDenied'
    case 'EACCES':
    case 'EROFS': return 'PermissionDenied'
    case 'EBUSY': return 'Busy'
    case 'EXDEV': return 'CrossesDevices'
    case 'ENOTSUP':
    case 'EOPNOTSUPP': return 'NotSupported'
    case 'ENAMETOOLONG': return 'InvalidPath'
    default: return 'Unknown'
  }
}

/** An error of `node:fs` with a POSIX code becomes an `FsError`; any other error is kept. */
export function toFsError(error: unknown, url: URL, operation: Operation) {
  if (error instanceof FsError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code !== 'string' || !/^E[A-Z0-9]+$/.test(code)) return error
  return new FsError(getCode(code, operation), url, (error as Error).message, { cause: error })
}
