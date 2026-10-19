/** A point in a config file, as a character offset into its source text. */
export interface SourceLocation {
  filename: string
  source: string
  offset: number
}

/** 1-based line and column of an offset. */
function getPosition(source: string, offset: number) {
  let line = 1
  let lineStart = 0
  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) {
    line += 1
    lineStart = index + 1
  }
  return { line, column: offset - lineStart + 1 }
}

/** `file:line:column`, which terminals and editors open at the position. */
export function formatLocation(location: SourceLocation) {
  const { line, column } = getPosition(location.source, location.offset)
  return `${location.filename}:${line}:${column}`
}

/**
 * One line of a config failure: what is wrong, and where it is written down.
 * `name` is the path of the offending value within the entry, if any.
 */
export function formatIssue(message: string, location?: SourceLocation, name?: string) {
  const where = [name, location && formatLocation(location)].filter(Boolean).join(', ')
  return where ? `  - ${message} (at ${where})` : `  - ${message}`
}
