import { composeError, Context } from 'cordis'
import { Dict, isNonNullable } from 'cosmokit'
import { Entry, EntryOptions } from './entry.ts'
import { EntryGroup } from './group.ts'
import { createResolve } from '../resolve.ts'

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

  ensureId(options: Partial<EntryOptions>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(16).slice(2, 10)
      } while (this.store[options.id])
    } else if (options.id.includes(EntryTree.sep)) {
      // IDs containing the tree separator cannot be resolved by resolve().
      throw new Error(`entry id must not contain "${EntryTree.sep}": ${options.id}`)
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
    // a config file can omit `name`; without it there is no specifier to import
    if (!name) {
      return composeError(() => {
        throw new Error('entry name is required')
      }, getOuterStack)
    }
    const baseUrl = this.ctx.baseUrl || this.root?.ctx?.baseUrl
    if (name.startsWith('cordis:')) {
      return composeError(() => {
        const plugin = this.ctx.loader.builtins[name.slice(7)]
        if (!plugin) throw this.unresolvable(name, baseUrl)
        return plugin
      }, getOuterStack)
    }
    return composeError(async (info) => {
      // ModuleJob.run
      // onImport.tracePromise.__proto__
      // internal.import
      info.offset += 3
      if (this.ctx.loader.internal) {
        if (!baseUrl && name.startsWith('.')) throw this.unresolvable(name, baseUrl)
        const parentURL = baseUrl || import.meta.url
        // a bare specifier carries no url to compare against, so the entry is
        // left unknown and a set `error.url` then belongs to a dependency
        const entry = name.startsWith('.') ? new URL(name, parentURL).href : undefined
        try {
          return await this.ctx.loader.internal.import(name, parentURL, {})
        } catch (error: any) {
          if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
          if (error.url && error.url !== entry) throw error
          if (!error.url && !error.message?.includes(`'${name}'`) && (!entry || !error.message?.includes(`'${entry}'`))) throw error
          throw this.unresolvable(name, baseUrl)
        }
      }
      let url = name
      if (name.startsWith('.')) {
        // a relative specifier cannot be anchored without a base url, and
        // `new URL` throws a bare TypeError for it
        if (!baseUrl) throw this.unresolvable(name, baseUrl)
        url = new URL(name, baseUrl).href
      } else {
        // An `import()` written here anchors on this file, reaching the loader's
        // own dependencies. A helper inside the config file's project supplies
        // that project as the anchor; the plain import applies when no project
        // can be located.
        const resolve = await createResolve(baseUrl)
        if (resolve) {
          try {
            url = resolve(name)
          } catch {
            // `import.meta.resolve` only resolves; any failure is a resolve failure
            throw this.unresolvable(name, baseUrl)
          }
        }
      }
      try {
        return await import(/* @vite-ignore */ url)
      } catch (error: any) {
        // an entry that cannot resolve is re-anchored to the config; one that
        // resolved but failed to load keeps Node's error, which names the
        // dependency that is actually missing
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
        if (error.url && error.url !== url) throw error
        if (!error.url && !error.message?.includes(`'${name}'`) && (!url || !error.message?.includes(`'${url}'`))) throw error
        throw this.unresolvable(name, baseUrl)
      }
    }, getOuterStack)
  }

  private unresolvable(name: string, baseUrl = this.ctx.baseUrl || this.root?.ctx?.baseUrl) {
    const from = baseUrl ? ` from ${baseUrl}` : ''
    return new Error(`cannot resolve ${name}${from}`)
  }

  abstract commit(change: EntryChange): void
}
