import { ModuleJob } from '@cordisjs/plugin-loader'

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
export async function collectDependencies(root: ModuleJob, stop?: Set<string>, excludePackages?: boolean) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (dependencies.has(job.url)) return
    if (isBuiltin(job.url) || excludePackages && isPackaged(job.url) || stop?.has(job.url)) return
    dependencies.add(job.url)
    // `linked` is a promise on 22 and an array on 24
    const children = await job.linked
    await Promise.all(Array.prototype.map.call(children, traverse))
  }
  await traverse(root)
  return dependencies
}
