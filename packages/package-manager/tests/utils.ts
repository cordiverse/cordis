import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterAll } from 'vitest'

const temp = mkdtempSync(join(tmpdir(), 'cordis-package-manager-'))
let counter = 0

afterAll(() => {
  rmSync(temp, { recursive: true, force: true })
})

export function toPosix(path: string) {
  return path.split(sep).join('/')
}

/** Create an empty directory, whose path is real. */
export function createDir() {
  const dir = join(temp, `project-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

/** Create a project with the files, or write them into an existing one. JSON files are given as values. */
export function createProject(files: Record<string, unknown>, dir = join(temp, `project-${++counter}`)) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}
