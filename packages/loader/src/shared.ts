import { Context, EffectScope, ForkScope, Service } from '@cordisjs/core'
import { defineProperty, Dict, isNullable, valueMap } from 'cosmokit'
import { constants, promises as fs } from 'fs'
import { interpolate } from './utils.ts'
import * as yaml from 'js-yaml'
import * as path from 'path'

declare module '@cordisjs/core' {
  interface Events {
    'config'(): void
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/entry'(type: string, entry: Entry): void
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

export namespace Entry {
  export interface Options {
    id: string
    name: string
    config?: any
    disabled?: boolean
    intercept?: Dict
    isolate?: Dict<boolean | string>
    when?: any
  }
}

function swapAssign<T extends {}>(target: T, source?: T): T {
  const result = { ...target }
  for (const key in result) {
    delete target[key]
  }
  Object.assign(target, source)
  return result
}

export class Entry {
  public fork: ForkScope | null = null
  public isUpdate = false

  constructor(public loader: Loader, public parent: Context, public options: Entry.Options) {}

  amend(ctx: Context) {
    swapAssign(ctx[Context.intercept], this.options.intercept)
    const neoMap: Dict<symbol> = Object.create(Object.getPrototypeOf(ctx[Context.isolate]))
    for (const [key, label] of Object.entries(this.options.isolate ?? {})) {
      if (typeof label === 'string') {
        neoMap[key] = (this.loader.realms[label] ??= Object.create(null))[key] ??= Symbol(key)
      } else if (label) {
        neoMap[key] = Symbol(key)
      }
    }
    for (const key in { ...ctx[Context.isolate], ...neoMap }) {
      if (neoMap[key] === ctx[Context.isolate][key]) continue
      const self = Object.create(null)
      self[Context.filter] = (ctx2: Context) => {
        return ctx[Context.isolate][key] === ctx2[Context.isolate][key]
      }
      ctx.emit(self, 'internal/before-service', key)
    }
    const oldMap = swapAssign(ctx[Context.isolate], neoMap)
    for (const key in { ...oldMap, ...ctx[Context.isolate] }) {
      if (oldMap[key] === ctx[Context.isolate][key]) continue
      const self = Object.create(null)
      self[Context.filter] = (ctx2: Context) => {
        return ctx[Context.isolate][key] === ctx2[Context.isolate][key]
      }
      ctx.emit(self, 'internal/service', key)
    }
  }

  // TODO: handle parent change
  update(parent: Context, options: Entry.Options) {
    this.options = options
    if (!this.loader.isTruthyLike(options.when) || options.disabled) {
      this.stop()
    } else {
      this.start()
    }
  }

  async start() {
    if (this.fork) {
      this.isUpdate = true
      this.amend(this.fork.parent)
      this.fork.update(this.options.config)
    } else {
      this.parent.emit('loader/entry', 'apply', this)
      const plugin = await this.loader.resolve(this.options.name)
      if (!plugin) return
      const ctx = this.parent.extend({
        [Context.intercept]: Object.create(this.parent[Context.intercept]),
        [Context.isolate]: Object.create(this.parent[Context.isolate]),
      })
      this.amend(ctx)
      this.fork = ctx.plugin(plugin, this.loader.interpolate(this.options.config))
      this.fork.entry = this
    }
  }

  stop() {
    if (!this.fork) return
    this.parent.emit('loader/entry', 'unload', this)
    this.fork.dispose()
    this.fork = null
  }
}

export namespace Loader {
  export interface Options {
    name: string
    immutable?: boolean
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

  public entryFork!: ForkScope<Context>
  public suspend = false
  public writable = false
  public mimeType!: string
  public filename!: string
  public entries: Dict<Entry> = Object.create(null)
  public realms: Dict<Dict<symbol>> = Object.create(null)

  private tasks = new Set<Promise<any>>()

  abstract import(name: string): Promise<any>

  constructor(public app: Context, public options: T) {
    super(app, 'loader', true)
    this.realms.root = app.root[Context.isolate]
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
    for (const extname of supported) {
      const filename = this.options.name + extname
      if (files.includes(filename)) {
        this.mimeType = writable[extname]
        this.filename = path.resolve(this.baseDir, filename)
        return
      }
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

  async writeConfig(silent = false) {
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

  async reload() {
    const config = await this.readConfig()
    this.entryFork.update(config)
    this.app.emit('config')
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

  async update(parent: Context, options: Entry.Options) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(36).slice(2, 8)
      } while (this.entries[options.id])
    }

    const entry = this.entries[options.id] ??= new Entry(this, parent, options)
    entry.update(parent, options)
  }

  remove(parent: Context, options: Entry.Options) {
    const entry = this.entries[options.id]
    if (!entry) return
    entry.stop()
    delete this.entries[options.id]
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
    this.entryFork = this.app.plugin(group, this.config)

    this.app.on('dispose', () => {
      this.exit()
    })

    this.app.on('internal/update', (fork) => {
      const entry = this.entries[fork.entry?.options.id!]
      if (!entry) return
      fork.parent.emit('loader/entry', 'reload', entry)
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
      fork.parent.emit('loader/entry', 'unload', fork.entry)
      // fork is disposed by main scope (e.g. hmr plugin)
      // normal: ctx.dispose() -> fork / runtime dispose -> delete(plugin)
      // hmr: delete(plugin) -> runtime dispose -> fork dispose
      if (!this.app.registry.has(fork.runtime.plugin)) return
      fork.entry.options.disabled = true
      this.writeConfig()
    })

    while (this.tasks.size) {
      await Promise.all(this.tasks)
    }
  }

  unwrapExports(module: any) {
    return module?.default || module
  }

  exit() {}
}

export function group(ctx: Context, config: Entry.Options[]) {
  for (const entry of config) {
    ctx.loader.update(ctx, entry)
  }

  ctx.accept((neo: Entry.Options[]) => {
    // update config reference
    const old = ctx.scope.config as Entry.Options[]
    const oldMap = Object.fromEntries(old.map(entry => [entry.id, entry]))
    const neoMap = Object.fromEntries(neo.map(entry => [entry.id, entry]))

    // update inner plugins
    for (const id in { ...oldMap, ...neoMap }) {
      if (!neoMap[id]) {
        ctx.loader.remove(ctx, oldMap[id])
      } else {
        ctx.loader.update(ctx, neoMap[id])
      }
    }
  }, { passive: true })

  ctx.on('dispose', () => {
    for (const entry of ctx.scope.config as Entry.Options[]) {
      ctx.loader.remove(ctx, entry)
    }
  })
}

defineProperty(group, 'inject', ['loader'])
defineProperty(group, 'reusable', true)

export default Loader
