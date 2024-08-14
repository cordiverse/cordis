import { Context } from '@cordisjs/core'
import { Entry, EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.scope.entry
    if (entry) entry.subgroup = this
  }

  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const entry = this.tree.store[id] ??= new Entry(this.ctx.loader)
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    await entry.update(options, true)
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string) {
    const entry = this.tree.store[id]
    if (!entry) return
    entry.stop()
    this.unlink(entry.options)
    delete this.tree.store[id]
    this.ctx.emit('loader/partial-dispose', entry, entry.options, false)
  }

  update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    for (const id of Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]) {
      if (newMap[id]) {
        this.create(newMap[id]).catch((error) => {
          this.ctx.emit(this.ctx, 'internal/error', error)
        })
      } else {
        this.remove(id)
      }
    }
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id)
    }
  }
}

export class Group extends EntryGroup {
  static reusable = true
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context) {
    super(ctx, ctx.scope.entry!.parent.tree)
    ctx.on('dispose', () => this.stop())
    ctx.accept((config: EntryOptions[]) => {
      this.update(config)
    }, { passive: true, immediate: true })
  }
}
