import { Context, Inject, Service } from '@cordisjs/core'
import { defineProperty, Dict, isNullable } from 'cosmokit'
import { ModuleLoader } from './internal.ts'
import { Entry, EntryOptions } from './config/entry.ts'
import { LoaderFile } from './config/file.ts'
import { ImportTree } from './config/import.ts'
import isolate from './config/isolate.ts'

export * from './config/entry.ts'
export * from './config/file.ts'
export * from './config/group.ts'
export * from './config/import.ts'
export * from './config/isolate.ts'
export * from './config/tree.ts'

declare module '@cordisjs/core' {
  interface Events {
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/config-update'(): void
    'loader/entry-init'(entry: Entry): void
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void
    'loader/patch-context'(entry: Entry, next: () => void): void
  }

  interface Context {
    baseDir: string
    loader: Loader<this>
  }

  interface EnvData {
    startTime?: number
  }

  interface Fiber<C> {
    entry?: Entry<C>
  }
}

export namespace Loader {
  export interface Config {
    name: string
    initial?: Omit<EntryOptions, 'id'>[]
    filename?: string
  }

  export interface Intercept {}
}

export abstract class Loader<C extends Context = Context> extends ImportTree<C> {
  declare [Service.config]: Loader.Intercept

  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public params = {
    env: process.env,
  }

  public files: Dict<LoaderFile> = Object.create(null)
  public delims: Dict<symbol> = Object.create(null)
  public internal?: ModuleLoader

  constructor(public ctx: C, public config: Loader.Config) {
    super(ctx)

    defineProperty(this, Service.tracker, {
      associate: 'loader',
      property: 'ctx',
      noShadow: true,
    })

    ctx.provide('loader', this)

    ctx.on('internal/update', (fiber, config) => {
      if (!fiber.entry) return
      this.showLog(fiber.entry, 'reload')
    }, { global: true })

    ctx.on('internal/update', (fiber, config) => {
      if (!fiber.entry) return
      if (fiber.entry.suspend) return fiber.entry.suspend = false
      const unparse = fiber.runtime?.Config?.['simplify']
      fiber.entry.options.config = unparse ? unparse(config) : config
      fiber.entry.parent.tree.write()
    }, { global: true, prepend: true })

    ctx.on('internal/plugin', (fiber) => {
      // 1. set `fiber.entry`
      if (fiber.parent[Entry.key] && !fiber.entry) {
        fiber.entry = fiber.parent[Entry.key]
        // FIXME merge config
        Inject.resolve(fiber.entry!.options.inject, fiber.inject)
      }

      // 2. handle self-dispose
      // We only care about `ctx.fiber.dispose()`, so we need to filter out other cases.

      // case 1: fiber is created
      if (fiber.uid) return

      // case 2: fiber is not tracked by loader
      if (!fiber.entry) return

      // case 3: fiber is disposed on behalf of plugin deletion (such as plugin hmr)
      // self-dispose: ctx.fiber.dispose() -> fiber / runtime dispose -> delete(plugin)
      // plugin hmr: delete(plugin) -> runtime dispose -> fiber dispose
      if (!ctx.registry.has(fiber.runtime!.callback)) return

      this.showLog(fiber.entry, 'unload')

      // case 4: fiber is disposed by loader behavior
      // such as inject checker, config file update, ancestor group disable
      if (fiber.entry.disabled) return

      fiber.entry.options.disabled = true
      fiber.entry.parent.tree.write()
    })

    ctx.plugin(isolate)
  }

  async* [Service.init]() {
    await this.init(process.cwd(), this.config)
    yield* super[Service.init]()
  }

  showLog(entry: Entry, type: string) {
    if (entry.options.group) return
    this.ctx.get('logger')?.('loader').info('%s plugin %c', type, entry.options.name)
  }

  locate(fiber = this.ctx.fiber) {
    while (1) {
      if (fiber.entry) return fiber.entry.id
      const next = fiber.parent.fiber
      if (fiber === next) return
      fiber = next
    }
  }

  exit() {}

  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
}

export default Loader
