import { valueMap } from 'cosmokit'

// eslint-disable-next-line no-new-func
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`) as ((ctx: object, expr: string) => any)

export function interpolate(ctx: object, value: any) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(ctx, item))
  } else {
    return valueMap(value, item => interpolate(ctx, item))
  }
}

export function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && '__jsExpr' in value
}

// `isJsExpr` alone would also accept `{ __jsExpr: 1 }`
function isExpression(value: any): value is JsExpr {
  return isJsExpr(value) && typeof value.__jsExpr === 'string'
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

/** `path` names the value, relative to the config or the entry options. */
export function formatIssue(message: string, location?: SourceLocation, path?: string) {
  const where = [path, location && formatLocation(location)].filter(Boolean).join(', ')
  return where ? `  - ${message} (at ${where})` : `  - ${message}`
}

export interface Issue {
  message: string
  path: PropertyKey[]
}

export type Locate = (path: PropertyKey[]) => SourceLocation | undefined

/** `title:` followed by one line per issue, located by `locate` if given. */
export function formatIssues(title: string, issues: readonly Issue[], locate?: Locate) {
  const lines = issues.map(({ message, path }) => {
    return formatIssue(message, locate?.(path), path.length ? path.map(String).join('.') : undefined)
  })
  return `${title}:\n${lines.join('\n')}`
}

/**
 * Give `error` a new message, and replace its stack frames with the entry
 * frames, which say more about the source than internal frames do.
 */
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

// an expression is an object too, but no field other than `disabled` is interpolated
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !isJsExpr(value)
}

/**
 * Type issues of the entry options, with paths relative to the options. Only
 * `disabled` accepts an expression; other fields are not interpolated. An
 * absent `id` is fine, as the tree assigns one.
 */
export function validateOptions(options: unknown, sep: string): Issue[] {
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
    // the tree separator would make the id unresolvable
    issues.push({ message: `id must not contain "${sep}"`, path: ['id'] })
  }
  check('name', 'a string', value => typeof value === 'string', true)
  check('group', 'a boolean', value => typeof value === 'boolean')
  // an expression is evaluated to a boolean, so it is not worth a mention
  check('disabled', 'a boolean', value => typeof value === 'boolean' || isExpression(value))
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
  return issues
}
