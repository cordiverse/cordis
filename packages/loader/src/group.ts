import { Context } from '@cordisjs/core'
import { Entry } from './entry.ts'

export class EntryGroup {
  static inject = ['loader']

  public config: Entry.Options[] = []

  constructor(public ctx: Context) {}

  async _create(options: Omit<Entry.Options, 'id'>) {
    const id = this.ctx.loader.ensureId(options)
    const entry = this.ctx.loader.entries[id] ??= new Entry(this.ctx.loader, this)
    entry.parent = this
    await entry.update(options as Entry.Options)
    return id
  }

  _remove(id: string) {
    const entry = this.ctx.loader.entries[id]
    if (!entry) return
    entry.stop()
    entry.unlink()
    delete this.ctx.loader.entries[id]
  }

  update(config: Entry.Options[]) {
    const oldConfig = this.config as Entry.Options[]
    this.config = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    for (const id of Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]) {
      if (newMap[id]) {
        this._create(newMap[id]).catch((error) => {
          this.ctx.emit('internal/error', error)
        })
      } else {
        this._remove(id)
      }
    }
  }

  dispose() {
    for (const options of this.config) {
      this._remove(options.id)
    }
  }
}
