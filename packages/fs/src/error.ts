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

  constructor(public code: FsError.Code, public url: URL | undefined, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

FsError.prototype[kFsError] = true

export namespace FsError {
  export type Code =
    /** No provider is mounted for the location. */
    | 'NoProvider'
    /** The provider of the location does not implement the operation, or the storage does not support it. */
    | 'NotSupported'
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
    /** The two locations are not in the same provider or device, so the operation cannot be performed as one. */
    | 'CrossesDevices'
    /** The input is not a valid location. */
    | 'InvalidPath'
    /** The storage reports a failure of no other category. */
    | 'Unknown'
}
