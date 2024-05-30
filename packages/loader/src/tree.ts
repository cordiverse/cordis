import { Context } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import { Entry } from './entry.ts'
import { EntryGroup } from './group.ts'

export abstract class EntryTree {
  static readonly sep = ':'
  static readonly [EntryGroup.key] = true

  public url!: string
  public root: EntryGroup
  public store: Dict<Entry> = Object.create(null)

  constructor(public ctx: Context) {
    this.root = new EntryGroup(ctx, this)
    const entry = ctx.scope.entry
    if (entry) entry.subtree = this
  }

  * entries(): Generator<Entry, void, void> {
    for (const entry of Object.values(this.store)) {
      yield entry
      if (!entry.subtree) continue
      yield* entry.subtree.entries()
    }
  }

  ensureId(options: Partial<Entry.Options>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(36).slice(2, 8)
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

  async create(options: Omit<Entry.Options, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    group.data.splice(position, 0, options as Entry.Options)
    group.tree.write()
    return group.create(options)
  }

  remove(id: string) {
    const entry = this.resolve(id)
    entry.parent.remove(id)
    entry.parent.tree.write()
  }

  async update(id: string, options: Omit<Entry.Options, 'id' | 'name'>, parent?: string | null, position?: number) {
    const entry = this.resolve(id)
    const source = entry.parent
    if (parent !== undefined) {
      const target = this.resolveGroup(parent)
      source.unlink(entry.options)
      target.data.splice(position ?? Infinity, 0, entry.options)
      target.tree.write()
      entry.parent = target
    }
    source.tree.write()
    return entry.update(options)
  }

  async import(name: string) {
    if (this.ctx.loader.internal) {
      return this.ctx.loader.internal.import(name, this.url, {})
    } else {
      return import(name)
    }
  }

  abstract write(): void
}
