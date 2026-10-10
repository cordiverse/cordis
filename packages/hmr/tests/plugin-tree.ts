import { Context, Service } from 'cordis'
import { EntryGroup, EntryTree } from '@cordisjs/plugin-loader'
import { version } from './tree-dep.ts'

export const name = 'plugin-tree'

/**
 * A minimal entry tree host, in the shape of `@cordisjs/plugin-include`:
 * its fiber owns a subtree of entries, so those entries are fiber descendants
 * of this plugin and rebuilding it rebuilds all of them.
 *
 * The subtree hangs off an extra plain fiber, so the nested entry is two
 * levels down and its direct parent is never itself reloaded — the same shape
 * as a real `group: true` entry, whose plugin lives in node_modules and is
 * therefore excluded from reloads. This is what distinguishes an ancestor
 * walk from a parent-only check.
 */
export default class Tree extends EntryTree {
  static inject = ['loader']

  private group?: EntryGroup

  constructor(ctx: Context, public config: any) {
    super(ctx)
  }

  async* [Service.init]() {
    this.ctx.on('hmr-test/get-tree', () => version)
    await this.ctx.plugin((ctx: Context) => {
      this.group = new EntryGroup(ctx, this)
    })
    yield () => this.group?.stop()
    await this.group!.update([{
      id: 'nested',
      name: './plugin-nested',
    }] as any)

    // Optional stall, used by a test to keep this fiber initializing while a
    // second HMR batch arrives: `_setEpoch()` bails out while `inertia` is
    // pending, so this fiber's unload — and with it the disposal of the
    // intermediate fiber below — is deferred until the stall ends.
    const stats: any = ((globalThis as any).__hmrTest ??= {})
    if (stats.stallTreeInit) {
      await new Promise(resolve => setTimeout(resolve, stats.stallTreeInit))
    }
  }

  write() {}
}
