import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Dict } from 'cosmokit'

export type Resolve = (specifier: string) => string

// Order matters: the directory ignores itself before the helper appears in it.
const HELPER_FILES = {
  '.gitignore': '# created by cordis automatically\n*\n',
  // The one-argument form of `import.meta.resolve` anchors on this file, so
  // resolution happens in the project scope. A resolve call also survives a
  // bundling host, which transforms modules inside its root and redirects the
  // `import()` in them to its own resolver.
  'resolve.mjs': 'export default (specifier) => import.meta.resolve(specifier)\n',
}

const cache: Dict<Promise<Resolve | undefined>> = Object.create(null)

const RENAME_RETRIES = 10
const RENAME_BACKOFF = 20

/**
 * On Windows a rename over a file that another process holds open fails with
 * one of these; the lock is normally gone within milliseconds.
 */
function isTransientRenameError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

/** Nearest ancestor of `dir` that owns a `package.json`, if any. */
function findScope(dir: string) {
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

function resolveScope(baseUrl: string | undefined) {
  if (!baseUrl) return
  let dir: string
  try {
    dir = fileURLToPath(new URL('.', baseUrl))
  } catch {
    return
  }
  return findScope(dir)
}

async function write(path: string, content: string) {
  // The helper content is constant; skipping an identical rewrite avoids
  // repeating the rename that another process may have blocked.
  if (await readFile(path, 'utf8').catch(() => undefined) === content) return
  // Another process may be writing the same path; `rename` is atomic, so a
  // concurrent reader only ever observes the complete helper.
  const temp = `${path}.${process.pid}`
  await writeFile(temp, content)
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path)
      return
    } catch (error) {
      if (attempt >= RENAME_RETRIES || !isTransientRenameError(error)) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
      }
    }
    await sleep(RENAME_BACKOFF * (attempt + 1))
  }
}

async function _createResolve(scope: string): Promise<Resolve | undefined> {
  const dir = join(scope, '.cordis')
  try {
    await mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(HELPER_FILES)) {
      await write(join(dir, name), content)
    }
  } catch {
    // Read-only filesystems are legitimate; the caller falls back to a native `import()`.
    return
  }
  const url = pathToFileURL(join(dir, 'resolve.mjs')).href
  return (await import(/* @vite-ignore */ url)).default
}

export async function createResolve(baseUrl: string | undefined) {
  const scope = resolveScope(baseUrl)
  if (!scope) return
  const resolve = await (cache[scope] ??= _createResolve(scope))
  // A scope that cannot be prepared may succeed on a later attempt.
  if (!resolve) delete cache[scope]
  return resolve
}
