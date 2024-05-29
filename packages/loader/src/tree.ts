import { Dict, isNullable } from 'cosmokit'
import { Entry } from './entry.ts'
import { EntryGroup } from './group.ts'

export abstract class EntryTree {
  public url!: string
  public root!: EntryGroup
  public entries: Dict<Entry> = Object.create(null)

  ensureId(options: Partial<Entry.Options>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(36).slice(2, 8)
      } while (this.entries[options.id])
    }
    return options.id!
  }

  async update(id: string, options: Partial<Omit<Entry.Options, 'id' | 'name'>>) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    const override = { ...entry.options }
    for (const [key, value] of Object.entries(options)) {
      if (isNullable(value)) {
        delete override[key]
      } else {
        override[key] = value
      }
    }
    entry.parent.tree.write()
    return entry.update(override)
  }

  resolveGroup(id: string | null) {
    const group = id ? this.entries[id]?.children : this.root
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

  transfer(id: string, parent: string | null, position = Infinity) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    const source = entry.parent
    const target = this.resolveGroup(parent)
    source.unlink(entry.options)
    target.data.splice(position, 0, entry.options)
    source.tree.write()
    target.tree.write()
    if (source === target) return
    entry.parent = target
    if (!entry.fork) return
    const ctx = entry.createContext()
    entry.patch(entry.fork.parent, ctx)
  }

  abstract write(): void
}
