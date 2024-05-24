import { Context, EffectScope, Service } from '@cordisjs/core'
import { Dict, isNullable, valueMap } from 'cosmokit'
import { readdir, stat } from 'node:fs/promises'
import { ModuleLoader } from './internal.ts'
import { interpolate } from './utils.ts'
import { Entry } from './entry.ts'
import { EntryGroup } from './group.ts'
import { FileLoader } from './file.ts'
import * as path from 'node:path'

export * from './entry.ts'
export * from './file.ts'
export * from './group.ts'

declare module '@cordisjs/core' {
  interface Events {
    'config'(): void
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/entry'(type: string, entry: Entry): void
    'loader/patch'(entry: Entry, legacy?: Entry.Options): void
  }

  interface Context {
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

const writable = {
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

const supported = new Set(Object.keys(writable))

if (typeof require !== 'undefined') {
  // eslint-disable-next-line n/no-deprecated-api
  for (const extname in require.extensions) {
    supported.add(extname)
  }
}

export namespace Loader {
  export interface Options {
    name: string
    immutable?: boolean
    initial?: Omit<Entry.Options, 'id'>[]
  }
}

export abstract class Loader<T extends Loader.Options = Loader.Options> extends Service<Entry.Options[]> {
  // TODO auto inject optional when provided?
  static inject = {
    optional: ['loader'],
  }

  // process
  public baseDir = process.cwd()
  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public params = {
    env: process.env,
  }

  public file!: FileLoader<this>
  public root: EntryGroup
  public entries: Dict<Entry> = Object.create(null)
  public realms: Dict<Dict<symbol>> = Object.create(null)
  public delims: Dict<symbol> = Object.create(null)
  public internal?: ModuleLoader

  private tasks = new Set<Promise<any>>()

  constructor(public app: Context, public options: T) {
    super(app, 'loader', true)
    this.root = new EntryGroup(this.app)
    this.realms['#'] = app.root[Context.isolate]

    this.app.on('dispose', () => {
      this.exit()
    })

    this.app.on('internal/update', (fork) => {
      if (!fork.entry) return
      fork.parent.emit('loader/entry', 'reload', fork.entry)
    })

    this.app.on('internal/before-update', (fork, config) => {
      if (!fork.entry) return
      if (fork.entry.isUpdate) return fork.entry.isUpdate = false
      const { schema } = fork.runtime
      fork.entry.options.config = schema ? schema.simplify(config) : config
      this.file.write(this.config)
    })

    this.app.on('internal/fork', (fork) => {
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
      if (!this.app.registry.has(fork.runtime.plugin)) return
      fork.parent.emit('loader/entry', 'unload', fork.entry)
      fork.entry.options.disabled = true
      fork.entry.fork = undefined
      fork.entry.stop()
      this.file.write(this.config)
    })
  }

  async init(filename?: string) {
    if (filename) {
      filename = path.resolve(this.baseDir, filename)
      const stats = await stat(filename)
      if (stats.isFile()) {
        this.baseDir = path.dirname(filename)
        const extname = path.extname(filename)
        const type = writable[extname]
        if (!supported.has(extname)) {
          throw new Error(`extension "${extname}" not supported`)
        }
        this.file = new FileLoader(this, filename, type)
      } else {
        this.baseDir = filename
        await this.findConfig()
      }
    } else {
      await this.findConfig()
    }
    await this.file.checkAccess()
    this.app.provide('baseDir', this.baseDir, true)
  }

  private async findConfig() {
    const dirents = await readdir(this.baseDir, { withFileTypes: true })
    for (const extension of supported) {
      const dirent = dirents.find(dirent => dirent.name === this.options.name + extension)
      if (!dirent) continue
      if (!dirent.isFile()) {
        throw new Error(`config file "${dirent.name}" is not a file`)
      }
      const type = writable[extension]
      const name = path.resolve(this.baseDir, this.options.name + extension)
      this.file = new FileLoader(this, name, type)
      return
    }
    if (this.options.initial) {
      this.config = this.options.initial as any
      const type = writable['.yml']
      const name = path.resolve(this.baseDir, this.options.name + '.yml')
      this.file = new FileLoader(this, name, type)
      return this.file.write(this.config)
    }
    throw new Error('config file not found')
  }

  interpolate(source: any) {
    if (typeof source === 'string') {
      return interpolate(source, this.params, /\$\{\{(.+?)\}\}/g)
    } else if (!source || typeof source !== 'object') {
      return source
    } else if (Array.isArray(source)) {
      return source.map(item => this.interpolate(item))
    } else {
      return valueMap(source, item => this.interpolate(item))
    }
  }

  async resolve(name: string) {
    const task = this.file.import(name).catch((error) => {
      this.app.emit('internal/error', new Error(`Cannot find package "${name}"`))
      this.app.emit('internal/error', error)
    })
    this.tasks.add(task)
    task.finally(() => this.tasks.delete(task))
    return this.unwrapExports(await task)
  }

  isTruthyLike(expr: any) {
    if (isNullable(expr)) return true
    return !!this.interpolate(`\${{ ${expr} }}`)
  }

  ensureId(options: Partial<Entry.Options>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(36).slice(2, 8)
      } while (this.entries[options.id])
    }
    return options.id!
  }

  async update(id: string, options: Partial<Omit<Entry.Options, 'id' | 'name'>>) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    const override = { ...entry.options }
    for (const [key, value] of Object.entries(options)) {
      if (isNullable(value)) {
        delete override[key]
      } else {
        override[key] = value
      }
    }
    this.file.write(this.config)
    return entry.update(override)
  }

  resolveGroup(id: string | null) {
    const group = id ? this.entries[id]?.children : this.root
    if (!group) throw new Error(`entry ${id} not found`)
    return group
  }

  async create(options: Omit<Entry.Options, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    group.data.splice(position, 0, options as Entry.Options)
    this.file.write(this.config)
    return group._create(options)
  }

  remove(id: string) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    entry.parent._remove(id)
    this.file.write(this.config)
  }

  transfer(id: string, parent: string | null, position = Infinity) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    const source = entry.parent
    const target = this.resolveGroup(parent)
    source._unlink(entry.options)
    target.data.splice(position, 0, entry.options)
    this.file.write(this.config)
    if (source === target) return
    entry.parent = target
    if (!entry.fork) return
    const ctx = entry.createContext()
    entry.patch(entry.fork.parent, ctx)
  }

  locate(ctx = this[Context.current]) {
    return this._locate(ctx.scope).map(entry => entry.options.id)
  }

  _locate(scope: EffectScope): Entry[] {
    // root scope
    if (scope === scope.parent.scope) return []

    // runtime scope
    if (scope.runtime === scope) {
      return ([] as Entry[]).concat(...scope.runtime.children.map(child => this._locate(child)))
    }

    if (scope.entry) return [scope.entry]
    return this._locate(scope.parent.scope)
  }

  async start() {
    this.config = await this.file.read()
    this.root.update(this.config)

    while (this.tasks.size) {
      await Promise.all(this.tasks)
    }
  }

  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }

  exit() {}

  _clearRealm(key: string, name: string) {
    const hasRef = Object.values(this.entries).some((entry) => {
      if (!entry.fork) return false
      const label = entry.options.isolate?.[key]
      if (!label) return false
      return name === entry.resolveRealm(label)
    })
    if (hasRef) return
    delete this.realms[name][key]
    if (!Object.keys(this.realms[name]).length) {
      delete this.realms[name]
    }
  }
}

export default Loader
