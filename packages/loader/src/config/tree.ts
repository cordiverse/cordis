import { composeError, Context } from 'cordis'
import { Dict, isNonNullable } from 'cosmokit'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Entry, EntryOptions } from './entry.ts'
import { EntryGroup } from './group.ts'
import { EntryValidationError, SourceLocation, validateOptions } from './utils.ts'
import { createResolve } from '../resolve.ts'

// A Windows drive-letter path, e.g. `C:\app\plugin.js` or `C:/app/plugin.js`.
const driveLetter = /^[A-Za-z]:[\\/]/

/**
 * Node's `ERR_MODULE_NOT_FOUND` names the modules involved only in its message
 * (`url` is set for a missing file, but not for a missing package):
 * `Cannot find (module|package) '<target>' imported from <parent>`.
 */
function parseNotFound(error: any) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' || typeof error.message !== 'string') return
  const match = error.message.match(/^(Cannot find (?:module|package) '.*') imported from (.*)$/s)
  if (match) return { description: match[1] as string, parent: match[2] as string }
}

/** A parent as Node prints it: file URLs as paths. */
function toPath(url: string) {
  try {
    return url.startsWith('file:') ? fileURLToPath(url) : url
  } catch {
    return url
  }
}

/**
 * The module an entry name refers to cannot be found. A module that the
 * plugin imports in turn is reported by Node's own error instead, which points
 * into the plugin.
 */
export class ModuleNotFoundError extends Error {
  name = 'ModuleNotFoundError'
  code = 'ERR_MODULE_NOT_FOUND'

  constructor(public specifier: string, message: string) {
    super(message)
  }
}

/**
 * One tree-side mutation, reported to `EntryTree.commit()` synchronously after
 * it has been applied to `entry.options` / `group.data`.
 *
 * - `options` absent: the entry was removed from `group`.
 * - `legacy` absent: the entry was created in `group`.
 * - both present: the entry was updated and now lives in `group`; `from` is
 *   the group it left if the update moved it.
 */
export interface EntryChange {
  id: string
  group: EntryGroup
  from?: EntryGroup
  options?: EntryOptions
  legacy?: EntryOptions
}

export abstract class EntryTree {
  static readonly sep = ':'

  public ctx: Context
  public enableLogs?: boolean
  public root: EntryGroup
  public store: Dict<Entry> = Object.create(null)

  constructor(ctx: Context) {
    this.ctx = ctx.extend({ baseUrl: ctx.baseUrl })
    this.root = new EntryGroup(this.ctx, this)
    const entry = this.ctx.fiber.entry
    if (entry) entry.subtree = this
  }

  get context(): Context {
    return this.ctx
  }

  * entries(): Generator<Entry, void, void> {
    for (const entry of Object.values(this.store)) {
      yield entry
      if (!entry.subtree) continue
      yield* entry.subtree.entries()
    }
  }

  getTasks() {
    return [...this.entries()]
      .map(entry => entry._initTask || entry.fiber?.inertia)
      .filter(isNonNullable)
  }

  async await() {
    while (true) {
      const tasks = this.getTasks()
      if (!tasks.length) return
      await Promise.allSettled(tasks)
    }
  }

  /** Assign an id to anonymous options; `validateOptions` checks a given one. */
  ensureId(options: Partial<EntryOptions>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(16).slice(2, 10)
      } while (this.store[options.id])
    }
    return options.id!
  }

  resolve(id: string) {
    const parts = id.split(EntryTree.sep)
    let tree: EntryTree | undefined = this
    const final = parts.pop()!
    for (const part of parts) {
      tree = tree.store[part]?.subtree
      if (!tree) throw new Error(`cannot resolve entry ${id}`)
    }
    const entry = tree.store[final]
    if (!entry) throw new Error(`cannot resolve entry ${id}`)
    return entry
  }

  resolveGroup(id: string | null) {
    if (!id) return this.root
    const entry = this.resolve(id)
    if (!entry.subgroup) throw new Error(`entry ${id} is not a group`)
    return entry.subgroup
  }

  async create(options: Omit<EntryOptions, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    // Options passed in at runtime are checked before they reach the tree or
    // its source. They are not written anywhere yet, so they are not located.
    const issues = validateOptions(options, EntryTree.sep)
    if (issues.length) throw new EntryValidationError(issues)
    const id = group.tree.ensureId(options)
    group.data.splice(position, 0, options as EntryOptions)
    group.tree.commit({ id, group, options: options as EntryOptions })
    return group.create(options)
  }

  remove(id: string) {
    const entry = this.resolve(id)
    const group = entry.parent
    const legacy = entry.options
    group.remove(legacy.id)
    group.tree.commit({ id: legacy.id, group, legacy })
  }

  async update(id: string, options: Omit<EntryOptions, 'id' | 'name'>, parent?: string | null, position?: number) {
    const entry = this.resolve(id)
    const source = entry.parent
    const legacy = { ...entry.options }
    const issues = validateOptions(Entry.merge({ ...legacy }, options), EntryTree.sep)
    if (issues.length) throw new EntryValidationError(issues)
    if (parent !== undefined) {
      const target = this.resolveGroup(parent)
      source.unlink(entry.options)
      target.data.splice(position ?? Infinity, 0, entry.options)
      entry.parent = target
    }
    // `Entry.update` assigns the new options before its first `await`, so the
    // change is fully visible to `commit()` once the call returns.
    const task = entry.update(options, false, true)
    if (entry.parent.tree !== source.tree) {
      source.tree.commit({ id: legacy.id, group: source, legacy })
    }
    const from = entry.parent === source ? undefined : source
    entry.parent.tree.commit({ id: legacy.id, group: entry.parent, from, options: entry.options, legacy })
    return task
  }

  import(name: string, getOuterStack?: () => string[]) {
    if (name.startsWith('cordis:')) {
      return this.ctx.loader.builtins[name.slice(7)]
    }
    // On Windows, a drive-letter path is converted with `pathToFileURL`.
    if (process.platform === 'win32' && driveLetter.test(name)) {
      name = pathToFileURL(name).href
    }
    // the module `name` is resolved against, to tell its own resolution apart
    // from that of a module it imports in turn
    let parent: string | undefined
    // the helper resolves nothing but `name`, so whatever it cannot find is `name`
    let unresolved: unknown
    return composeError(async (info) => {
      // ModuleJob.run
      // onImport.tracePromise.__proto__
      // internal.import
      info.offset += 3
      if (this.ctx.loader.internal) {
        parent = this.ctx.baseUrl!
        return await this.ctx.loader.internal.import(name, parent, {})
      } else if (name.startsWith('.')) {
        parent = import.meta.url
        return await import(/* @vite-ignore */ new URL(name, this.ctx.baseUrl).href)
      } else {
        // An `import()` written here anchors on this file, reaching the loader's
        // own dependencies. A helper inside the config file's project supplies
        // that project as the anchor; the plain import applies when no project
        // can be located.
        const resolve = await createResolve(this.ctx.baseUrl)
        let url = name
        if (resolve) {
          try {
            url = resolve(name)
          } catch (error) {
            unresolved = error
            throw error
          }
        }
        parent = import.meta.url
        return await import(/* @vite-ignore */ url)
      }
    }, getOuterStack).catch((error: unknown) => {
      const notFound = parseNotFound(error)
      if (!notFound) throw error
      if (error !== unresolved && (!parent || notFound.parent !== toPath(parent))) throw error
      // the parent is internal to the loader, and says nothing about the entry
      const result = new ModuleNotFoundError(name, notFound.description)
      const frames = getOuterStack?.() ?? []
      // Node's frames are those of its resolver
      if (frames.length) result.stack = [`${result.name}: ${result.message}`, ...frames].join('\n')
      throw result
    })
  }

  abstract commit(change: EntryChange): void

  /**
   * Where a value of the entry options is written. A path that leaves the
   * source falls back to its deepest written ancestor.
   */
  getLocation(_id: string, _path: PropertyKey[]): SourceLocation | undefined {
    return undefined
  }
}
