import { Context, Service } from '@cordisjs/core'
import { Entry, EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

export class EntryGroup<C extends Context = Context> {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []

  constructor(public ctx: C, public tree: EntryTree) {
    const entry = ctx.scope.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
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
    entry.scope?.dispose()
    this.unlink(entry.options)
    delete this.tree.store[id]
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  async update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]
    await Promise.all(ids.map(async (id) => {
      if (newMap[id]) {
        await this.create(newMap[id]).catch((error) => {
          this.context.emit(this.ctx, 'internal/error', error)
        })
      } else {
        this.remove(id)
      }
    }))
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id)
    }
  }
}

export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx.scope.entry!.parent.tree)
    ctx.on('dispose', () => this.stop())
    ctx.on('internal/update', (_, config) => {
      this.update(config)
      return true
    })
  }

  async [Service.setup]() {
    await this.update(this.config)
  }
}
