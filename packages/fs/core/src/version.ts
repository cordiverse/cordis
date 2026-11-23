import type { Stats } from './entry.ts'
import { FsError } from './error.ts'

/** Checks a version given to a conditional operation before any I/O. */
export function checkVersion(value: unknown): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`expected \`ifMatch\` as a string, got ${value === null ? 'null' : typeof value}`)
  }
}

/**
 * Checks the entry at `url`, as found by the metadata of a provider with the
 * capability `conditional.stat`, against the version `ifMatch`. A missing
 * entry, an entry other than a file and another version fail with
 * `VersionMismatch`. A file without a version breaks the contract of the
 * capability, and fails with `Unknown`.
 */
export function matchVersion(url: URL, stats: Stats | undefined, ifMatch: string, prefix: string) {
  if (!stats) {
    throw new FsError('VersionMismatch', url, `expected a file of version ${JSON.stringify(ifMatch)} at ${url.href}, found no entry`)
  }
  if (stats.type !== 'file') {
    throw new FsError('VersionMismatch', url, `expected a file of version ${JSON.stringify(ifMatch)} at ${url.href}, found a ${stats.type}`)
  }
  if (typeof stats.version !== 'string') {
    throw new FsError('Unknown', url, `the provider mounted at ${prefix} reports no version of the file at ${url.href}`)
  }
  if (stats.version !== ifMatch) {
    throw new FsError('VersionMismatch', url, `expected a file of version ${JSON.stringify(ifMatch)} at ${url.href}, found version ${JSON.stringify(stats.version)}`)
  }
}
