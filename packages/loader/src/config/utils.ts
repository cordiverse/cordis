import { valueMap } from 'cosmokit'

// frames above the wrapper belong to the expression
const WRAPPER = '<cordis:evaluate>'

// eslint-disable-next-line no-new-func
const wrapper = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
//# sourceURL=${WRAPPER}`) as ((ctx: object, expr: string) => any)

let counter = 0

export interface ExprTrace {
  label: string
  locate: (expr: string, offset: number) => SourceLocation | undefined
  getOuterStack: () => string[]
}

export function evaluate(ctx: object, expr: string, trace?: ExprTrace) {
  if (!trace) return wrapper(ctx, expr)
  // unique, to tell nested evaluations apart
  const marker = `<cordis:expression#${++counter}>`
  try {
    return wrapper(ctx, `${expr}\n//# sourceURL=${marker}`)
  } catch (error) {
    traceEvaluation(error, expr, marker, trace)
    throw error
  }
}

export function interpolate(ctx: object, value: any, getTrace?: (path: PropertyKey[]) => ExprTrace, path: PropertyKey[] = []) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr, getTrace?.(path))
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map((item, index) => interpolate(ctx, item, getTrace, [...path, index]))
  } else {
    return valueMap(value, (item, key) => interpolate(ctx, item, getTrace, [...path, key]))
  }
}

const framePattern = /^(\s+at )(?:(.+) \((.+):(\d+):(\d+)\)|(.+):(\d+):(\d+))$/

function parseFrame(line: string) {
  const match = line.match(framePattern)
  if (!match) return
  const [, prefix, name, file = match[6], row = match[7], column = match[8]] = match
  return { prefix, name, file, line: +row, column: +column }
}

function toOffset(source: string, line: number, column: number) {
  const pattern = /\r\n?|[\n\u2028\u2029]/g
  let start = 0
  for (let i = 1; i < line; i++) {
    if (!pattern.exec(source)) return
    start = pattern.lastIndex
  }
  return start + column - 1
}

function traceEvaluation(error: any, expr: string, marker: string, trace: ExprTrace) {
  if (typeof error?.stack !== 'string') return
  const outer = trace.getOuterStack()
  const start = trace.locate(expr, 0)
  if (!outer.length && !start) return

  const lines: string[] = error.stack.split('\n')
  const head = lines.findIndex(line => parseFrame(line))
  if (head === -1) return
  let last = -1
  for (let i = head; i < lines.length; i++) {
    if (parseFrame(lines[i])?.file === marker) last = i
  }
  const cut = lines.findIndex((line, index) => index >= head && index > last && parseFrame(line)?.file === WRAPPER)
  // the stack may be cut short by `Error.stackTraceLimit`
  if (cut === -1) return

  const frames = lines.slice(head, cut).map((line, index) => {
    const frame = parseFrame(line)
    if (frame?.file !== marker) return line
    const offset = toOffset(expr, frame.line, frame.column)
    const location = offset === undefined ? undefined : trace.locate(expr, offset)
    const where = location ? formatLocation(location) : `${frame.file}:${frame.line}:${frame.column}`
    // V8 names both the expression and its anonymous functions `eval`
    const name = head + index === cut - 1 ? trace.label : frame.name === 'eval' ? undefined : frame.name
    return name ? `${frame.prefix}${name} (${where})` : `${frame.prefix}${where}`
  })
  // a syntax error has no frame of its own
  if (last !== cut - 1) {
    frames.push(start ? `    at ${trace.label} (${formatLocation(start)})` : `    at ${trace.label}`)
  }
  error.stack = [...lines.slice(0, head), ...frames, ...outer].join('\n')
}

export function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && typeof value.__jsExpr === 'string'
}

export function swap<T extends {}>(target: T, source?: T | null) {
  for (const key of Reflect.ownKeys(target)) {
    Reflect.deleteProperty(target, key)
  }
  for (const key of Reflect.ownKeys(source || {})) {
    Reflect.defineProperty(target, key, Reflect.getOwnPropertyDescriptor(source!, key)!)
  }
}

export interface JsExpr {
  __jsExpr: string
}

/** 1-based, with columns in UTF-16 code units. */
export interface SourceLocation {
  filename: string
  line: number
  column: number
}

export function formatLocation(location: SourceLocation) {
  return `${location.filename}:${location.line}:${location.column}`
}

export function formatIssue(message: string, location?: SourceLocation, path?: string) {
  const where = [path, location && formatLocation(location)].filter(Boolean).join(', ')
  return where ? `  - ${message} (at ${where})` : `  - ${message}`
}

export interface Issue {
  message: string
  path: PropertyKey[]
}

export type Locate = (path: PropertyKey[]) => SourceLocation | undefined

export function formatIssues(title: string, issues: readonly Issue[], locate?: Locate) {
  const lines = issues.map(({ message, path }) => {
    return formatIssue(message, locate?.(path), path.length ? path.map(String).join('.') : undefined)
  })
  return `${title}:\n${lines.join('\n')}`
}

export function relocate(error: Error, message: string, frames: string[]) {
  error.message = message
  error.stack = [`${error.name}: ${message}`, ...frames].join('\n')
}

export class EntryValidationError extends TypeError {
  name = 'EntryValidationError'

  constructor(public issues: Issue[]) {
    super(formatIssues('invalid entry options', issues))
  }
}

// only `disabled` takes an expression
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !isJsExpr(value)
}

export function validateOptions(options: unknown, sep: string, deep = false): Issue[] {
  if (!isPlainObject(options)) return [{ message: 'entry must be an object', path: [] }]
  const issues: Issue[] = []
  const check = (key: string, expected: string, valid: (value: any) => boolean, required = false) => {
    const value = options[key]
    if (value === undefined || value === null) {
      if (required) issues.push({ message: `${key} is required`, path: [key] })
    } else if (!valid(value)) {
      issues.push({ message: `${key} must be ${expected}`, path: [key] })
    }
  }

  check('id', 'a string', value => typeof value === 'string')
  if (typeof options.id === 'string' && options.id.includes(sep)) {
    issues.push({ message: `id must not contain "${sep}"`, path: ['id'] })
  }
  check('name', 'a string', value => typeof value === 'string', true)
  check('group', 'a boolean', value => typeof value === 'boolean')
  check('disabled', 'a boolean', value => typeof value === 'boolean' || isJsExpr(value))
  // a group's config is its entry list
  if (options.group === true) check('config', 'an array', Array.isArray, true)

  check('inject', 'an array or an object', value => Array.isArray(value) || isPlainObject(value))
  if (Array.isArray(options.inject)) {
    options.inject.forEach((name, index) => {
      if (typeof name === 'string') return
      issues.push({ message: `inject.${index} must be a string`, path: ['inject', index] })
    })
  }
  check('intercept', 'an object', isPlainObject)
  check('isolate', 'an object', isPlainObject)
  if (isPlainObject(options.isolate)) {
    for (const [name, label] of Object.entries(options.isolate)) {
      if (label === true || typeof label === 'string') continue
      issues.push({ message: `isolate.${name} must be true or a string`, path: ['isolate', name] })
    }
  }
  // from a source, each entry is checked as its group creates it
  if (deep && options.group === true && Array.isArray(options.config)) {
    options.config.forEach((child, index) => {
      for (const { message, path } of validateOptions(child, sep, true)) {
        issues.push({ message, path: ['config', index, ...path] })
      }
    })
  }
  return issues
}
