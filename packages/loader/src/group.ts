import { Context } from '@cordisjs/core'
import { Entry } from './entry.ts'
import { EntryTree } from './tree.ts'

export class EntryGroup {
  public data: Entry.Options[] = []

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.scope.entry
    if (entry) entry.subgroup = this
  }

  async create(options: Omit<Entry.Options, 'id'>) {
    const id = this.tree.ensureId(options)
    const entry = this.tree.store[id] ??= new Entry(this.ctx.loader, this)
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    await entry.update(options, true)
    return entry.id
  }

  unlink(options: Entry.Options) {
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
  }

  update(config: Entry.Options[]) {
    const oldConfig = this.data as Entry.Options[]
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    for (const id of Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]) {
      if (newMap[id]) {
        this.create(newMap[id]).catch((error) => {
          this.ctx.emit('internal/error', error)
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
  static key = Symbol('cordis.group')
  static reusable = true
  static initial: Omit<Entry.Options, 'id'>[] = []

  // TODO support options
  constructor(public ctx: Context) {
    super(ctx, ctx.scope.entry!.parent.tree)
    ctx.on('dispose', () => this.stop())
    ctx.accept((config: Entry.Options[]) => {
      this.update(config)
    }, { passive: true, immediate: true })
  }
}
