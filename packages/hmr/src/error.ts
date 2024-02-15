import { Context } from 'cordis'
import { BuildFailure } from 'esbuild'
import { codeFrameColumns } from '@babel/code-frame'
import { readFileSync } from 'fs'

function isBuildFailure(e: any): e is BuildFailure {
  return Array.isArray(e?.errors) && e.errors.every((error: any) => error.text)
}

export function handleError(ctx: Context, e: any) {
  if (!isBuildFailure(e)) {
    ctx.logger.warn(e)
    return
  }

  for (const error of e.errors) {
    if (!error.location) {
      ctx.logger.warn(error.text)
      continue
    }
    try {
      const { file, line, column } = error.location
      const source = readFileSync(file, 'utf8')
      const formatted = codeFrameColumns(source, {
        start: { line, column },
      }, {
        highlightCode: true,
        message: error.text,
      })
      ctx.logger.warn(`File: ${file}:${line}:${column}\n` + formatted)
    } catch (e) {
      ctx.logger.warn(e)
    }
  }
}
