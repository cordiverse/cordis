import { Context } from '@cordisjs/core'
import { Entry } from './entry.ts'
import Loader from './shared.ts'

export class EntryGroup {
  public config: Entry.Options[] = []

  constructor(public loader: Loader, public ctx: Context) {
    ctx.on('dispose', () => {
      for (const options of this.config) {
        this.loader._remove(options.id)
      }
    })
  }

  update(config: Entry.Options[]) {
    const oldConfig = this.config as Entry.Options[]
    this.config = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // update inner plugins
    for (const id of Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]) {
      if (!newMap[id]) {
        this.loader._remove(id)
      } else {
        this.loader._ensure(this.ctx, newMap[id])
      }
    }
  }
}
