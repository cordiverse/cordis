import type { ModuleJob } from '@cordisjs/plugin-loader'

// a builtin carries no file to watch or reload
export function isBuiltin(url: string) {
  return url.startsWith('node:')
}

// a module installed by a package manager
export function isPackaged(url: string) {
  return url.includes('/node_modules/')
}

// Collect the transitive static imports of `root`. `node_modules` is
// traversed: a shared dependency a plugin imports lives there, and so do the
// framework modules the host is built from. What stays out is `stop` — the
// modules that bound this walk, such as the host graph — plus package modules
// again while the host graph is unknown.
export async function collectDependencies(
  root: ModuleJob,
  stop?: Set<string>,
  excludePackages?: boolean,
  dependents?: Map<string, Set<string>>,
) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (dependencies.has(job.url)) return
    if (isBuiltin(job.url) || excludePackages && isPackaged(job.url) || stop?.has(job.url)) return
    dependencies.add(job.url)
    // `linked` is a promise on 22 and an array on 24, and the resolved value
    // is not guaranteed to be a real array — copy it through `map` so that the
    // rest of the walk can iterate it
    const linked = await job.linked
    const children = Array.prototype.map.call(linked, (child: ModuleJob) => child) as ModuleJob[]
    // the reverse edge is recorded here, where the walk already holds it: a
    // second pass over the closure would await every `linked` again
    if (dependents) {
      for (const child of children) {
        let parents = dependents.get(child.url)
        if (!parents) dependents.set(child.url, parents = new Set())
        parents.add(job.url)
      }
    }
    await Promise.all(children.map(traverse))
  }
  await traverse(root)
  return dependencies
}
