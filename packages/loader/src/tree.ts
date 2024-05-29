import { Context } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import { Entry } from './entry.ts'
import { EntryGroup } from './group.ts'

export abstract class EntryTree {
  public url!: string
  public root: EntryGroup
  public entries: Dict<Entry> = Object.create(null)

  constructor(public ctx: Context) {
    this.root = new EntryGroup(ctx, this)
    const entry = ctx.scope.entry
    if (entry) entry.subtree = this
  }

  ensureId(options: Partial<Entry.Options>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(36).slice(2, 8)
      } while (this.entries[options.id])
    }
    return options.id!
  }

  resolveGroup(id: string | null) {
    const group = id ? this.entries[id]?.subgroup : this.root
    if (!group) throw new Error(`entry ${id} not found`)
    return group
  }

  async create(options: Omit<Entry.Options, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    group.data.splice(position, 0, options as Entry.Options)
    group.tree.write()
    return group.create(options)
  }

  remove(id: string) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    entry.parent.remove(id)
    entry.parent.tree.write()
  }

  async update(id: string, options: Omit<Entry.Options, 'id' | 'name'>, parent?: string | null, position?: number) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    const source = entry.parent
    source.tree.write()
    let target: EntryGroup | undefined
    if (parent !== undefined) {
      target = this.resolveGroup(parent)
      source.unlink(entry.options)
      target.data.splice(position ?? Infinity, 0, entry.options)
      target.tree.write()
      entry.parent = target
    }
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
