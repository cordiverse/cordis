import { Context, EffectScope, Service } from '@cordisjs/core'
import { defineProperty, Dict, isNullable, valueMap } from 'cosmokit'
import { constants, promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ModuleLoader } from './internal.ts'
import { interpolate } from './utils.ts'
import { Entry } from './entry.ts'
import * as yaml from 'js-yaml'
import * as path from 'path'
import { EntryGroup } from './group.ts'

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

  public root: EntryGroup
  public suspend = false
  public writable = false
  public mimeType!: string
  public filename!: string
  public entries: Dict<Entry> = Object.create(null)
  public realms: Dict<Dict<symbol>> = Object.create(null)
  public delims: Dict<symbol> = Object.create(null)

  public internal?: ModuleLoader

  private tasks = new Set<Promise<any>>()
  private _writeTask?: Promise<void>
  private _writeSlient = true

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
      this.writeConfig()
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
      this.writeConfig()
    })

    this.app.on('loader/patch', (entry) => {})
  }

  async init(filename?: string) {
    if (filename) {
      filename = path.resolve(this.baseDir, filename)
      const stats = await fs.stat(filename)
      if (stats.isFile()) {
        this.filename = filename
        this.baseDir = path.dirname(filename)
        const extname = path.extname(filename)
        this.mimeType = writable[extname]
        if (!supported.has(extname)) {
          throw new Error(`extension "${extname}" not supported`)
        }
      } else {
        this.baseDir = filename
        await this.findConfig()
      }
    } else {
      await this.findConfig()
    }
    if (this.mimeType && !this.options.immutable) {
      try {
        await fs.access(this.filename, constants.W_OK)
        this.writable = true
      } catch {}
    }
    this.app.provide('baseDir', this.baseDir, true)
  }

  private async findConfig() {
    const files = await fs.readdir(this.baseDir)
    for (const extension of supported) {
      const filename = this.options.name + extension
      if (files.includes(filename)) {
        this.mimeType = writable[extension]
        this.filename = path.resolve(this.baseDir, filename)
        return
      }
    }
    if (this.options.initial) {
      this.config = this.options.initial as any
      this.mimeType = writable['.yml']
      this.filename = path.resolve(this.baseDir, this.options.name + '.yml')
      return this.writeConfig(true)
    }
    throw new Error('config file not found')
  }

  async readConfig() {
    if (this.mimeType === 'application/yaml') {
      this.config = yaml.load(await fs.readFile(this.filename, 'utf8')) as any
    } else if (this.mimeType === 'application/json') {
      // we do not use require / import here because it will pollute cache
      this.config = JSON.parse(await fs.readFile(this.filename, 'utf8')) as any
    } else {
      const module = await import(this.filename)
      this.config = module.default || module
    }
    return this.config
  }

  private async _writeConfig(silent = false) {
    this.suspend = true
    if (!this.writable) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.mimeType === 'application/yaml') {
      await fs.writeFile(this.filename, yaml.dump(this.config))
    } else if (this.mimeType === 'application/json') {
      await fs.writeFile(this.filename, JSON.stringify(this.config, null, 2))
    }
    if (!silent) this.app.emit('config')
  }

  writeConfig(silent = false) {
    this._writeSlient &&= silent
    if (this._writeTask) return this._writeTask
    return this._writeTask = new Promise((resolve, reject) => {
      setTimeout(() => {
        this._writeSlient = true
        this._writeTask = undefined
        this._writeConfig(silent).then(resolve, reject)
      }, 0)
    })
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

  async import(name: string) {
    if (this.internal) {
      return this.internal.import(name, pathToFileURL(this.filename).href, {})
    } else {
      return import(name)
    }
  }

  async resolve(name: string) {
    const task = this.import(name).catch((error) => {
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
    this.writeConfig()
    return entry.update(override)
  }

  resolveGroup(id: string | null) {
    const group = id ? this.entries[id]?.children : this.root
    if (!group) throw new Error(`entry ${id} not found`)
    return group
  }

  async create(options: Omit<Entry.Options, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    group.config.splice(position, 0, options as Entry.Options)
    this.writeConfig()
    return group._create(options)
  }

  remove(id: string) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    entry.stop()
    entry.unlink()
    delete this.entries[id]
    this.writeConfig()
  }

  transfer(id: string, parent: string | null, position = Infinity) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    const source = entry.parent
    const target = this.resolveGroup(parent)
    entry.unlink()
    target.config.splice(position, 0, entry.options)
    this.writeConfig()
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
    await this.readConfig()
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

export const kGroup = Symbol.for('cordis.group')

export interface GroupOptions {
  name?: string
  initial?: Omit<Entry.Options, 'id'>[]
  allowed?: string[]
}

export function createGroup(config?: Entry.Options[], options: GroupOptions = {}) {
  options.initial = config

  function group(ctx: Context) {
    if (!ctx.scope.entry) throw new Error(`expected entry scope`)
    const group = new EntryGroup(ctx)
    ctx.scope.entry.children = group
    ctx.on('dispose', () => {
      group.dispose()
    })
    ctx.accept((config: Entry.Options[]) => {
      group.update(config)
    }, { passive: true, immediate: true })
  }

  defineProperty(group, 'inject', ['loader'])
  defineProperty(group, 'reusable', true)
  defineProperty(group, kGroup, options)
  if (options.name) defineProperty(group, 'name', options.name)

  return group
}

export const group = createGroup()

export default Loader
