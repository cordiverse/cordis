import { resolve } from 'node:path'
import { createLocator, createManifestReader, readText } from '../files.ts'
import { InstallState, nameOf, PackageState } from '../state.ts'

/** an entry of `packages` in the hidden lockfile `node_modules/.package-lock.json` */
interface NpmLockEntry {
  name?: string
  version?: string
  resolved?: string
  integrity?: string
  link?: boolean
  inBundle?: boolean
}

/** Read the install state of a hoisted layout from the hidden lockfile of npm. */
export async function readNpmState(root: string): Promise<InstallState> {
  const state: InstallState = new Map()
  const text = await readText(resolve(root, 'node_modules/.package-lock.json'))
  if (!text) return state
  const packages: Record<string, NpmLockEntry> = JSON.parse(text).packages ?? {}
  const locate = await createLocator(root)
  const { readName } = createManifestReader()

  // A bundled entry records only its version, since its content is that of
  // the tarball of its bundler, i.e. the nearest enclosing package that is
  // not bundled itself.
  const identify = (location: string): Pick<PackageState, 'resolution' | 'local'> => {
    const entry = packages[location]
    const own = entry.integrity ?? entry.resolved ?? `${entry.name ?? nameOf(location)}@${entry.version}`
    const local = !entry.integrity && !!entry.resolved?.startsWith('file:')
    const index = location.lastIndexOf('/node_modules/')
    if (!entry.inBundle || index < 0) return { resolution: own, local }
    const bundler = location.slice(0, index)
    // a workspace or the target of a link
    if (!bundler.includes('node_modules/') || !packages[bundler]) return { resolution: own, local: true }
    const outer = identify(bundler)
    return { resolution: `${own} ${outer.resolution}`, local: local || outer.local }
  }

  for (const [location, entry] of Object.entries(packages)) {
    if (!location.includes('node_modules/')) continue
    if (entry.link) {
      // the name is recorded by the target entry, if it differs from the directory name
      const name = packages[entry.resolved!]?.name ?? await readName(resolve(root, entry.resolved!)) ?? nameOf(location)
      state.set(location, { name, resolution: `link:${entry.resolved}`, local: true, realPath: await locate(location, true) })
      continue
    }
    const identity = identify(location)
    const realPath = await locate(location, identity.local)
    state.set(location, { name: entry.name ?? nameOf(location), version: entry.version, ...identity, realPath })
  }
  return state
}
