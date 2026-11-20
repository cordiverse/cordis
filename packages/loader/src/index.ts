import { Context, Service } from 'cordis'
import { defineProperty } from 'cosmokit'
import { Entry } from './config/entry.ts'
import { EntryChange, EntryTree } from './config/tree.ts'
import { getInternalLoader, unwrapExports } from './internal.ts'

export * from './config/entry.ts'
export * from './config/group.ts'
export * from './config/isolate.ts'
export * from './config/tree.ts'
export * from './config/utils.ts'

declare module 'cordis' {
  interface Events {
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/config-update'(): void
  }

  interface Context {
    loader: Loader
    [Entry.key]?: Entry
  }

  interface EnvData {
    startTime?: number
  }
}

export namespace Loader {
  export interface Intercept {
    await?: boolean
  }
}

export class Loader extends EntryTree {
  declare [Service.metadata]: Loader.Intercept

  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public name = 'loader'
  public internal = getInternalLoader()

  constructor(ctx: Context) {
    super(ctx)

    defineProperty(this, Service.tracker, {
      associate: 'loader',
      property: 'ctx',
      noShadow: true,
    })

    ctx.reflect.provide('loader', this, this[Service.check])
  }

  commit(_change: EntryChange) {
    // the root tree lives in memory only; there is nothing to persist to
  }

  [Service.check]() {
    const config: Loader.Intercept = Service.prototype[Service.resolveIntercept].call(this)
    if (config.await && this.getTasks().length) return false
    return true
  }

  showLog(entry: Entry, type: string) {
    if (entry.options.group || !entry.parent.tree.enableLogs) return
    this.ctx[Context.root].logger?.('loader').info('%s component %C', type, entry.options.name)
  }

  locate(fiber = this.ctx.fiber) {
    return fiber.ctx[Entry.key]?.id
  }

  unwrapExports(exports: any) {
    return unwrapExports(exports)
  }
}

export default Loader
