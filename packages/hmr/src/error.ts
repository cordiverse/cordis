import { Logger } from 'cordis'
import { BuildFailure } from 'esbuild'
import { codeFrameColumns } from '@babel/code-frame'
import { readFileSync } from 'fs'

function isBuildFailure(e: any): e is BuildFailure {
  return Array.isArray(e?.errors) && e.errors.every((error: any) => error.text)
}

export function handleError(e: any, logger: Logger) {
  if (!isBuildFailure(e)) {
    logger.warn(e)
    return
  }

  for (const error of e.errors) {
    if (!error.location) {
      logger.warn(error.text)
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
      logger.warn(`File: ${file}:${line}:${column}\n` + formatted)
    } catch (e) {
      logger.warn(e)
    }
  }
}
