import { relative } from 'node:path'

/** A span of a config file, as character offsets into its source text. */
export interface SourceLocation {
  filename: string
  source: string
  start: number
  end: number
}

export interface SourcePosition {
  line: number
  column: number
}

/** 1-based line and column of an offset. */
export function getPosition(source: string, offset: number): SourcePosition {
  let line = 1
  let lineStart = 0
  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) {
    line += 1
    lineStart = index + 1
  }
  return { line, column: offset - lineStart + 1 }
}

/**
 * `file:line:column`, which terminals and editors open at the position. With
 * `short`, paths under the working directory are shortened to a relative form.
 */
export function formatLocation(location: SourceLocation, short = false) {
  const { line, column } = getPosition(location.source, location.start)
  let filename = location.filename
  if (short) {
    const path = relative(process.cwd(), filename)
    if (path && !path.startsWith('..')) filename = path
  }
  return `${filename}:${line}:${column}`
}

/** The source line of the span with the span underlined; a multi-line span is cut at the line end. */
export function codeFrame(location: SourceLocation, indent = '') {
  const { source, start } = location
  const { line, column } = getPosition(source, start)
  const lineStart = start - column + 1
  let lineEnd = source.indexOf('\n', lineStart)
  if (lineEnd === -1) lineEnd = source.length
  const text = source.slice(lineStart, lineEnd).replace(/\r$/, '')
  const width = Math.max(1, Math.min(location.end, lineStart + text.length) - start)
  const gutter = ' '.repeat(String(line).length)
  // tabs are kept so that the marker lines up however wide they are rendered
  const padding = text.slice(0, column - 1).replace(/[^\t]/g, ' ')
  return [
    `${indent}${line} | ${text}`,
    `${indent}${gutter} | ${padding}${'^'.repeat(width)}`,
  ]
}

/**
 * Lines of one issue in a config failure: the message, then where the
 * offending value is written down. `name` is the path of the value, if any.
 */
export function formatIssue(message: string, location?: SourceLocation, name?: string) {
  if (!location) return [name ? `  - ${message} (at ${name})` : `  - ${message}`]
  const position = formatLocation(location, true)
  return [
    `  - ${message}`,
    name ? `    at ${name} (${position})` : `    at ${position}`,
    ...codeFrame(location, '      '),
  ]
}
