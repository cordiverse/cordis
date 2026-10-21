/** A point in a config file. Both are 1-based; columns count UTF-16 code units. */
export interface SourceLocation {
  filename: string
  line: number
  column: number
}

/** `file:line:column`, which terminals and editors open at the position. */
export function formatLocation(location: SourceLocation) {
  return `${location.filename}:${location.line}:${location.column}`
}

/**
 * One line of a failed config validation: what is wrong, and where it is
 * written down. `path` locates the offending value within the entry config.
 */
export function formatIssue(message: string, location?: SourceLocation, path?: string) {
  const where = [path, location && formatLocation(location)].filter(Boolean).join(', ')
  return where ? `  - ${message} (at ${where})` : `  - ${message}`
}
