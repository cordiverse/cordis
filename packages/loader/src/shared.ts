import { Context, EffectScope, Service } from '@cordisjs/core'
import { defineProperty, Dict, isNullable, valueMap } from 'cosmokit'
import { constants, promises as fs } from 'fs'
import { interpolate } from './utils.ts'
import { Entry } from './entry.ts'
import * as yaml from 'js-yaml'
import * as path from 'path'

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
  // process
  public baseDir = process.cwd()
  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public params = {
    env: process.env,
  }

  public root: Entry
  public suspend = false
  public writable = false
  public mimeType!: string
  public filename!: string
  public entries: Dict<Entry> = Object.create(null)
  public realms: Dict<Dict<symbol>> = Object.create(null)

  private tasks = new Set<Promise<any>>()
  private _writeTask?: Promise<void>
  private _writeSlient = true

  abstract import(name: string): Promise<any>

  constructor(public app: Context, public options: T) {
    super(app, 'loader', true)
    this.root = new Entry(this)
    this.entries[''] = this.root
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
      // fork.uid: fork is created (we only care about fork dispose event)
      // fork.parent.runtime.plugin !== group: fork is not tracked by loader
      if (fork.uid || !fork.entry) return
      // fork is disposed by main scope (e.g. hmr plugin)
      // normal: ctx.dispose() -> fork / runtime dispose -> delete(plugin)
      // hmr: delete(plugin) -> runtime dispose -> fork dispose
      if (!this.app.registry.has(fork.runtime.plugin)) return
      fork.parent.emit('loader/entry', 'unload', fork.entry)
      fork.entry.options.disabled = true
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

  async resolve(name: string) {
    const task = this.import(name)
    this.tasks.add(task)
    task.finally(() => this.tasks.delete(task))
    return this.unwrapExports(await task)
  }

  isTruthyLike(expr: any) {
    if (isNullable(expr)) return true
    return !!this.interpolate(`\${{ ${expr} }}`)
  }

  private ensureId(options: Partial<Entry.Options>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(36).slice(2, 8)
      } while (this.entries[options.id])
    }
    return options.id!
  }

  async _ensure(parent: Context, options: Omit<Entry.Options, 'id'>) {
    const id = this.ensureId(options)
    const entry = this.entries[id] ??= new Entry(this)
    await entry.update(parent, options as Entry.Options)
    return id
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
    return entry.update(entry.parent, override)
  }

  async create(options: Omit<Entry.Options, 'id'>, target = '', index = Infinity) {
    const targetEntry = this.entries[target]
    if (!targetEntry?.fork) throw new Error(`entry ${target} not found`)
    targetEntry.options.config.splice(index, 0, options)
    this.writeConfig()
    return this._ensure(targetEntry.fork.ctx, options)
  }

  _remove(id: string) {
    const entry = this.entries[id]
    if (!entry) return
    entry.stop()
  }

  remove(id: string) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    entry.stop()
    entry.unlink()
    delete this.entries[id]
    this.writeConfig()
  }

  teleport(id: string, target: string, index = Infinity) {
    const entry = this.entries[id]
    if (!entry) throw new Error(`entry ${id} not found`)
    const sourceEntry = entry.parent.scope.entry!
    const targetEntry = this.entries[target]
    if (!targetEntry?.fork) throw new Error(`entry ${target} not found`)
    entry.unlink()
    targetEntry.options.config.splice(index, 0, entry.options)
    this.writeConfig()
    if (sourceEntry === targetEntry) return
    entry.parent = targetEntry.fork.ctx
    if (!entry.fork) return
    entry.amend()
  }

  paths(scope: EffectScope): string[] {
    // root scope
    if (scope === scope.parent.scope) return []

    // runtime scope
    if (scope.runtime === scope) {
      return ([] as string[]).concat(...scope.runtime.children.map(child => this.paths(child)))
    }

    if (scope.entry) return [scope.entry.options.id]
    return this.paths(scope.parent.scope)
  }

  async start() {
    await this.readConfig()
    this.root.update(this.app, {
      id: '',
      name: 'cordis/group',
      config: this.config,
    })

    while (this.tasks.size) {
      await Promise.all(this.tasks)
    }
  }

  unwrapExports(module: any) {
    return module?.default || module
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

  function group(ctx: Context, config: Entry.Options[]) {
    const loader = ctx.get('loader')!
    for (const options of config) {
      loader._ensure(ctx, options)
    }

    ctx.accept((neo: Entry.Options[]) => {
      // update config reference
      const old = ctx.scope.config as Entry.Options[]
      const oldMap: any = Object.fromEntries(old.map(entry => [entry.id, entry]))
      const neoMap: any = Object.fromEntries(neo.map(entry => [entry.id, entry]))

      // update inner plugins
      for (const id in { ...oldMap, ...neoMap }) {
        if (!neoMap[id]) {
          loader._remove(id)
        } else {
          loader._ensure(ctx, neoMap[id])
        }
      }
    }, { passive: true })

    ctx.on('dispose', () => {
      for (const entry of ctx.scope.config as Entry.Options[]) {
        loader._remove(entry.id)
      }
    })
  }

  defineProperty(group, 'reusable', true)
  defineProperty(group, kGroup, options)
  if (options.name) defineProperty(group, 'name', options.name)

  return group
}

export const group = createGroup()

export default Loader
