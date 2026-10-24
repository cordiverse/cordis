import { Context, Fiber, FiberState, Inject, Service, ValidationError } from 'cordis'
import { Awaitable, defineProperty, isNullable } from 'cosmokit'
import { ModuleLoader } from './internal.ts'
import { Entry, EntryOptions } from './config/entry.ts'
import { EntryGroup } from './config/group.ts'
import isolate from './config/isolate.ts'
import { EntryChange, EntryTree } from './config/tree.ts'
import { interpolate } from './config/utils.ts'

export * from './config/entry.ts'
export * from './config/group.ts'
export * from './config/isolate.ts'
export * from './config/tree.ts'
export * from './config/utils.ts'
export * from './internal.ts'

declare module 'cordis' {
  interface Events {
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/config-update'(): void
    'loader/entry-init'(entry: Entry): void
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void
    'loader/patch-context'(entry: Entry, next: () => Awaitable<void>): Awaitable<void>
  }

  interface Context {
    loader: Loader
  }

  interface EnvData {
    startTime?: number
  }

  interface Fiber {
    entry?: Entry
  }
}

export namespace Loader {
  export interface Config {
    baseUrl?: string
  }

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
  public internal = ModuleLoader.fromInternal()

  constructor(ctx: Context, public config: Loader.Config = {}) {
    super(ctx)
    if (config.baseUrl) {
      this.ctx.baseUrl = config.baseUrl
    }
    const self = this

    defineProperty(this, Service.tracker, {
      associate: 'loader',
      property: 'ctx',
      noShadow: true,
    })

    ctx.reflect.provide('loader', this, this[Service.check])

    // the source config each entry fiber last resolved
    const sources = new WeakMap<Fiber, any>()

    // Registered before the built-in validation listener, so validation
    // failures can be traced to the config source. A config passed in at
    // runtime is not written anywhere yet, so its failures are left as is.
    ctx.on('internal/config', (fiber, next) => {
      if (!fiber.entry || fiber.parent.fiber?.entry === fiber.entry) return next()
      try {
        return next()
      } catch (error) {
        if (ValidationError.is(error) && sources.get(fiber) === fiber.entry.options.config) {
          fiber.entry.traceValidation(error)
        }
        throw error
      }
    }, { prepend: true })

    // Registered after the built-in validation listener, so interpolation runs
    // on the source config and validation sees the interpolated result.
    ctx.on('internal/config', (fiber, next) => {
      const config = next()
      // nested plugins inherit `entry` through the context prototype chain;
      // only the entry's own fiber carries the entry config
      if (!fiber.entry || fiber.parent.fiber?.entry === fiber.entry) return config
      sources.set(fiber, config)
      // a group's config is the entry list itself, which the loader mutates in
      // place and identifies by reference
      if (fiber.runtime!.callback[EntryGroup.key]) return config
      return interpolate(fiber.ctx, config, fiber.entry.trace, ['config'])
    })

    ctx.on('internal/commit', (fiber, config) => {
      if (!fiber.entry || fiber.parent.fiber?.entry === fiber.entry) return
      const unparse = fiber.runtime?.Config?.['simplify']
      const { entry } = fiber
      const legacy = { ...entry.options }
      entry.options.config = unparse ? unparse(config) : config
      entry.parent.tree.commit({ id: entry.options.id, group: entry.parent, options: entry.options, legacy })
    })

    ctx.on('internal/update', function (config, next) {
      if (!this.entry || this.parent.fiber?.entry === this.entry) return next()
      self.showLog(this.entry, 'reload')
      return next()
    }, { global: true })

    ctx.on('internal/status', (fiber) => {
      if (!Entry.isOuter(fiber) || fiber.state !== FiberState.UNLOADING) return
      const entry: Entry = fiber.parent[Entry.key]
      // dependency loss unloads the outer fiber without `entry.dispose()`;
      // the uid check skips an outer fiber that has been replaced
      if (entry.outerFiber?.uid === fiber.uid) entry._verdict = undefined
    })

    // the outer fiber is created with the entry's own `inject`; a replacement
    // installs the inject the new plugin declares instead, so the entry's own
    // has to be merged back on top of it
    ctx.on('internal/replace', (fiber) => {
      if (!Entry.isOuter(fiber)) return
      const entry: Entry | undefined = fiber.parent[Entry.key]
      if (!entry) return
      Inject.resolve(entry.options.inject, fiber.inject)
    })

    ctx.on('internal/plugin', (fiber) => {
      // 1. set `fiber.entry`
      // the inner fiber, not the outer one, is the entry's root
      if (fiber.parent[Entry.key] && !fiber.entry && !Entry.isOuter(fiber)) {
        fiber.entry = fiber.parent[Entry.key]
      }

      // 2. handle self-dispose
      // We only care about `ctx.fiber.dispose()`, so we need to filter out other cases.

      // case 1: fiber is created
      if (fiber.uid) return

      // case 2: fiber is not tracked by loader
      if (!fiber.entry) return

      // case 3: fiber is a child plugin under the entry (not the entry's root fiber)
      if (fiber.parent.fiber?.entry === fiber.entry) return

      // case 5: the entry's tree is being disposed
      if (!fiber.entry.parent.tree.ctx.fiber.uid) return

      const { entry } = fiber
      this.showLog(entry, 'unload')

      // case 6: the entry's parent is being unloaded, which takes the entry with it
      // (the parent may still be registered, e.g. when it has lost a dependency)
      if (fiber.parent.fiber.state === FiberState.UNLOADING) return

      // case 7: the entry is being removed by the loader (`EntryGroup.remove`
      // unregisters it before disposing the fiber)
      if (entry.parent.tree.store[entry.options.id] !== entry) return

      // case 8: fiber is disposed by loader behavior through `entry.dispose()`,
      // such as config file update, ancestor group disable, rebuild
      if (entry._disposing) return

      const legacy = { ...entry.options }
      entry.options.disabled = true
      entry._verdict = true
      entry.parent.tree.commit({ id: entry.options.id, group: entry.parent, options: entry.options, legacy })
      if (entry.outerFiber) entry.dispose()
    })

    ctx.plugin(isolate)
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
    this.ctx[Context.root].logger?.('loader').info('%s plugin %C', type, entry.options.name)
  }

  locate(fiber = this.ctx.fiber) {
    while (1) {
      if (fiber.entry) return fiber.entry.id
      const next = fiber.parent.fiber
      if (fiber === next) return
      fiber = next
    }
  }

  exit() {
  }

  unwrapExports(exports: any) {
    return unwrapExports(exports)
  }
}

// get the plugin exported by a module namespace
export function unwrapExports(exports: any) {
  if (isNullable(exports)) return exports
  exports = exports.default ?? exports
  // https://github.com/evanw/esbuild/issues/2623
  // https://esbuild.github.io/content-types/#default-interop
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}

export default Loader
