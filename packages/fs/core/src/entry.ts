/** The type of an entry. A symbolic link is `symlink`; any type other than these is `other`. */
export type EntryType = 'file' | 'directory' | 'symlink' | 'other'

/** The metadata of an entry. */
export interface Stats {
  type: EntryType
  /** the length of the content in bytes for a file, implementation-defined for other types */
  size: number
  /** the time of the last modification of the content, or of the entries of a directory */
  mtime: Date
  /** the permission bits, as in the lower 12 bits of a POSIX mode */
  mode?: number
  /** the number of the entry in its device */
  ino?: bigint
  /** the number of the device of the entry */
  dev?: bigint
  /**
   * The version of a file, which a provider with the capability
   * `conditional.stat` reports for every file. It is an opaque string,
   * compared for equality with other versions of the same location.
   */
  version?: string
}

export interface StatOptions {
  /** `false` reports a symbolic link itself, as `lstat` does; `true` by default */
  follow?: boolean
}

export interface MkdirOptions {
  /** Missing parent directories are created, and an existing directory is not an error. */
  recursive?: boolean
}

export interface RemoveOptions {
  /** A directory is removed with every entry below it. */
  recursive?: boolean
  /** A missing location is not an error. */
  force?: boolean
}

/** An entry of a directory, as a provider lists it. */
export interface DirEntry {
  name: string
  /** the type of the entry itself, not of the target of a link */
  type: EntryType
}

export interface WriteOptions {
  /** An existing file fails with `AlreadyExists`, checked when the file is created. */
  exclusive?: boolean
  /**
   * The permission bits that the file is given before its content, as in the
   * lower 12 bits of a POSIX mode, where the provider has permissions.
   */
  mode?: number
  /**
   * A reader observes either the previous or the new content, and a write
   * that fails leaves the previous content.
   */
  atomic?: boolean
  /**
   * The version of the file to be replaced, as `Stats.version` reports it.
   * The write fails with `VersionMismatch` unless the destination is a file
   * of this version.
   */
  ifMatch?: string
}

/** The result of a write. */
export interface WriteResult {
  /** the version of the written content, if the provider reports it */
  version?: string
}

export interface CopyOptions extends Pick<WriteOptions, 'exclusive' | 'atomic'> {
  /** A directory is copied with every entry below it. */
  recursive?: boolean
  /** The entries that symbolic links point to are copied instead of the links. */
  dereference?: boolean
}
