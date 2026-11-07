export type FsErrorCode =
  /** The location or one of its parent directories does not exist. */
  | 'NotFound'
  /** The operation requires the location not to exist, and it exists. */
  | 'AlreadyExists'
  /** A component of the path is not a directory, or a directory operation is applied to a non-directory. */
  | 'NotADirectory'
  /** A file operation is applied to a directory. */
  | 'IsADirectory'
  /** The operation requires an empty directory, and the directory is not empty. */
  | 'DirectoryNotEmpty'
  /** The storage denies the operation. */
  | 'PermissionDenied'
  /** The entry is in use; the operation may succeed later. */
  | 'Busy'
  /** The two locations are not on the same device, so the operation cannot be performed as one. */
  | 'CrossesDevices'
  /** The operation is not supported, or no implementation handles the scheme of the location. */
  | 'NotSupported'
  /** The input is not a valid location. */
  | 'InvalidPath'
  /** The storage reports a failure of no other category. */
  | 'Unknown'

const kFsError = Symbol.for('cordis.fs.error')

/**
 * A failure of a file system operation. The set of codes will grow, so a
 * caller keeps a default branch.
 */
export class FsError extends Error {
  // `instanceof` also recognizes an error from another copy of this package
  static [Symbol.hasInstance](value: unknown) {
    return !!(value as any)?.[kFsError]
  }

  name = 'FsError'
  declare [kFsError]: true

  /**
   * @param url the location of the operation, absent when the input is not a valid location
   */
  constructor(public code: FsErrorCode, message: string, public url?: URL, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
  }
}

FsError.prototype[kFsError] = true

export type Operation = 'read' | 'write' | 'access' | 'rename' | 'remove'

/**
 * The code is determined by the error of `node:fs` and the operation alone, so
 * that classifying an error performs no further I/O.
 */
function getCode(code: string, operation: Operation): FsErrorCode {
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
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code !== 'string' || !/^E[A-Z0-9]+$/.test(code)) return error
  return new FsError(getCode(code, operation), (error as Error).message, url, { cause: error })
}
