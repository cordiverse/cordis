import { Context, EffectScope } from '@cordisjs/core'
import { Dict, isNullable } from 'cosmokit'
import { ModuleLoader } from './internal.ts'
import { Entry } from './entry.ts'
import { ImportTree, LoaderFile } from './file.ts'

export * from './entry.ts'
export * from './file.ts'
export * from './group.ts'
export * from './tree.ts'

declare module '@cordisjs/core' {
  interface Events {
    'config'(): void
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/entry'(type: string, entry: Entry): void
    'loader/patch'(entry: Entry, legacy?: Entry.Options): void
  }

  interface Context {
    baseDir: string
    loader: Loader
  }

  interface EnvData {
    startTime?: number
  }

  // Theoretically, these properties will only appear on `ForkScope`.
  // We define them directly on `EffectScope` for typing convenience.
  interface EffectScope {
    entry?: Entry
  }
}

export namespace Loader {
  export interface Config {
    name: string
    initial?: Omit<Entry.Options, 'id'>[]
    filename?: string
  }
}

export abstract class Loader extends ImportTree {
  // TODO auto inject optional when provided?
  static inject = {
    optional: ['loader'],
  }

  // process
  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public params = {
    env: process.env,
  }

  public files: Dict<LoaderFile> = Object.create(null)
  public realms: Dict<Dict<symbol>> = Object.create(null)
  public delims: Dict<symbol> = Object.create(null)
  public internal?: ModuleLoader

  constructor(public ctx: Context, public config: Loader.Config) {
    super(ctx)

    this.ctx.set('loader', this)
    this.realms['#'] = ctx.root[Context.isolate]

    this.ctx.on('internal/update', (fork) => {
      if (!fork.entry) return
      fork.parent.emit('loader/entry', 'reload', fork.entry)
    })

    this.ctx.on('internal/before-update', (fork, config) => {
      if (!fork.entry) return
      if (fork.entry.suspend) return fork.entry.suspend = false
      const { schema } = fork.runtime
      fork.entry.options.config = schema ? schema.simplify(config) : config
      fork.entry.parent.tree.write()
    })

    this.ctx.on('internal/fork', (fork) => {
      if (fork.parent[Entry.key]) {
        fork.entry = fork.parent[Entry.key]
        delete fork.parent[Entry.key]
      }
      // fork.uid: fork is created (we only care about fork dispose event)
      // fork.parent.runtime.plugin !== group: fork is not tracked by loader
      if (fork.uid || !fork.entry) return
      // fork is disposed by main scope (e.g. hmr plugin)
      // normal: ctx.dispose() -> fork / runtime dispose -> delete(plugin)
      // hmr: delete(plugin) -> runtime dispose -> fork dispose
      if (!this.ctx.registry.has(fork.runtime.plugin)) return
      fork.parent.emit('loader/entry', 'unload', fork.entry)
      fork.entry.options.disabled = true
      fork.entry.fork = undefined
      fork.entry.stop()
      fork.entry.parent.tree.write()
    })

    this.ctx.on('internal/before-service', (name) => {
      for (const entry of this.entries()) {
        entry.checkService(name)
      }
    }, { global: true })

    this.ctx.on('internal/service', (name) => {
      for (const entry of this.entries()) {
        entry.checkService(name)
      }
    }, { global: true })

    const checkInject = (scope: EffectScope, name: string) => {
      if (!scope.runtime.plugin) return false
      if (scope.runtime === scope) {
        return scope.runtime.children.every(fork => checkInject(fork, name))
      }
      if (scope.entry?.deps.includes(name)) return true
      return checkInject(scope.parent.scope, name)
    }

    this.ctx.on('internal/inject', function (this, name) {
      return checkInject(this.scope, name)
    })
  }

  async start() {
    await this.init(process.cwd(), this.config)
    await super.start()
  }

  locate(ctx = this[Context.current]) {
    return this._locate(ctx.scope).map(entry => entry.id)
  }

  _locate(scope: EffectScope): Entry[] {
    // root scope
    if (!scope.runtime.plugin) return []

    // runtime scope
    if (scope.runtime === scope) {
      return scope.runtime.children.flatMap(child => this._locate(child))
    }

    if (scope.entry) return [scope.entry]
    return this._locate(scope.parent.scope)
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

  _clearRealm(key: string, realm: string) {
    for (const entry of this.entries()) {
      if (entry.hasIsolate(key, realm)) return
    }
    delete this.realms[realm][key]
    if (!Object.keys(this.realms[realm]).length) {
      delete this.realms[realm]
    }
  }
}

export default Loader
