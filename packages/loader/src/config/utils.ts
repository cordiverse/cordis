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

/** `path` locates the value within the entry config. */
export function formatIssue(message: string, location?: SourceLocation, path?: string) {
  const where = [path, location && formatLocation(location)].filter(Boolean).join(', ')
  return where ? `  - ${message} (at ${where})` : `  - ${message}`
}
