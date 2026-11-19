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
  /**
   * The permission bits that the file is given before its content, as in the
   * lower 12 bits of a POSIX mode, where the provider has permissions.
   */
  mode?: number
}

export interface CopyOptions {
  /** A directory is copied with every entry below it. */
  recursive?: boolean
  /** An existing file at the destination is replaced; `true` by default. */
  overwrite?: boolean
  /** The entries that symbolic links point to are copied instead of the links. */
  dereference?: boolean
}

/**
 * The location of the entry `name` of the directory at `directory`, without a
 * trailing separator. The query and the fragment of `directory` are removed.
 * The characters of `name` that the URL parser would change are
 * percent-encoded: `%`, `?`, `#` and `\` end a segment, and the parser removes
 * controls and spaces at the ends of the input, and tabs and newlines
 * anywhere. A name such as `a:b` is not read as a scheme.
 */
export function entryUrl(directory: URL, name: string): URL {
  const base = new URL(directory)
  base.search = ''
  base.hash = ''
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  // eslint-disable-next-line no-control-regex
  const encoded = name.replace(/[\x00-\x20%?#\\]/g, (char) => {
    return '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  })
  return new URL('./' + encoded, base)
}
