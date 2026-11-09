import { realpath as realpathCallback } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

/**
 * The real path as Node resolves modules. Node's module resolution uses the
 * implementation of `fs.realpath` that resolves the links along the path one
 * by one and keeps the rest of the path as given. `fs.promises.realpath` uses
 * the libuv implementation, which on Windows also expands 8.3 short names and
 * normalizes the case, so that its result can differ from module URLs.
 */
export const realpath: (path: string) => Promise<string> = promisify(realpathCallback)

/** Read a text file, or `undefined` if it does not exist. */
export async function readText(path: string) {
  try {
    return await readFile(path, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
    throw error
  }
}

/** The fields of a `package.json` manifest that the readers use. A field of another type is absent. */
export interface Manifest {
  name?: string
  version?: string
}

function parseManifest(text: string): Manifest | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return
  }
  if (typeof data !== 'object' || !data) return
  const { name, version } = data as Record<string, unknown>
  return {
    name: typeof name === 'string' ? name : undefined,
    version: typeof version === 'string' ? version : undefined,
  }
}

/**
 * Create a reader of `package.json` manifests, which reads each directory
 * once and reads a missing or invalid manifest as `undefined`. Each reading
 * of an install state creates its own reader, so that the states before and
 * after an installation do not share manifests.
 */
export function createManifestReader() {
  const manifests = new Map<string, Promise<Manifest | undefined>>()
  const readManifest = (dir: string) => {
    let manifest = manifests.get(dir)
    if (!manifest) {
      manifests.set(dir, manifest = readText(resolve(dir, 'package.json')).then(text => text ? parseManifest(text) : undefined))
    }
    return manifest
  }
  const readName = async (dir: string) => (await readManifest(dir))?.name
  return { readManifest, readName }
}

/**
 * Create a function that computes the real directory of a location in a
 * hoisted layout:
 *
 * - for a local package, including a link at the location itself;
 * - for another package, only from the real directory of the parent, which
 *   is resolved once for all siblings.
 */
export async function createLocator(root: string) {
  const realRoot = await realpath(root).catch(() => resolve(root))
  const parents = new Map<string, Promise<string>>()
  return async (location: string, local: boolean) => {
    const path = resolve(root, location)
    const fallback = resolve(realRoot, location)
    if (local) return realpath(path).catch(() => fallback)
    const parent = dirname(path)
    let real = parents.get(parent)
    if (!real) parents.set(parent, real = realpath(parent).catch(() => dirname(fallback)))
    return join(await real, basename(path))
  }
}
