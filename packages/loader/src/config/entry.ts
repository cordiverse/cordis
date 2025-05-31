import { Context, Fiber, Inject } from '@cordisjs/core'
import { deepEqual, isNullable } from 'cosmokit'
import { Loader } from '../loader.ts'
import { EntryGroup } from './group.ts'
import { EntryTree } from './tree.ts'
import { evaluate, interpolate } from './utils.ts'

export interface EntryOptions {
  id: string
  name: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: Inject | null
}

function takeEntries(object: {}, keys: string[]) {
  const result: [string, any][] = []
  for (const key of keys) {
    if (!(key in object)) continue
    result.push([key, object[key]])
    delete object[key]
  }
  return result
}

function sortKeys<T extends {}>(object: T, prepend = ['id', 'name'], append = ['config']): T {
  const part1 = takeEntries(object, prepend)
  const part2 = takeEntries(object, append)
  const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b))
  return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]))
}

export class Entry<C extends Context = Context> {
  static readonly key = Symbol.for('cordis.entry')

  public ctx: C
  public fiber?: Fiber<C>
  public parent!: EntryGroup<C>
  // safety: call `entry.update()` immediately after creating an entry
  public options = {} as EntryOptions
  public subgroup?: EntryGroup<C>
  public subtree?: EntryTree<C>

  _initTask?: Promise<void>

  constructor(public loader: Loader<C>) {
    this.ctx = loader.ctx.extend({ [Entry.key]: this })
    this.context.emit('loader/entry-init', this)
  }

  get context(): Context {
    return this.ctx
  }

  get id() {
    let id = this.options.id
    if (this.parent.tree.ctx.fiber.entry) {
      id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id
    }
    return id
  }

  get disabled() {
    // group is always enabled
    if (this.options.group) return false
    let entry: Entry | undefined = this
    do {
      if (entry.options.disabled) return true
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return false
  }

  evaluate(expr: string) {
    return evaluate(this.ctx, expr)
  }

  _resolveConfig(plugin: any): [any, any?] {
    if (plugin[EntryGroup.key]) return this.options.config
    return interpolate(this.ctx, this.options.config)
  }

  private _patchContext(diff: string[]) {
    this.context.waterfall('loader/patch-context', this, () => {
      Object.setPrototypeOf(this.ctx, this.parent.ctx)

      if (this.fiber?.uid && (diff.includes('config') || this.options.group)) {
        this.fiber.update(this._resolveConfig(this.fiber.runtime!.callback), true)
      }
    })
  }

  async refresh() {
    if (this.fiber) return
    if (this.disabled) return
    await this.init()
  }

  async update(options: Partial<EntryOptions>, create = false, force = false) {
    const legacy = { ...this.options }

    // step 1: update options
    if (create) {
      this.options = options as EntryOptions
    } else {
      for (const [key, value] of Object.entries(options)) {
        if (isNullable(value)) {
          delete this.options[key]
        } else {
          this.options[key] = value
        }
      }
    }
    sortKeys(this.options)

    // step 2: execute
    if (this.disabled) {
      this.fiber?.dispose()
      return
    }

    // step 3: check if options are changed
    if (this.fiber?.uid) {
      const diff = Object
        .keys({ ...this.options, ...legacy })
        .filter(key => !deepEqual(this.options[key], legacy[key]))
      if (!diff.length && !force) return
      this.context.emit('loader/partial-dispose', this, legacy, true)
      this._patchContext(diff)
    } else {
      await this.init()
    }
  }

  getOuterStack = () => {
    let entry: Entry<C> | undefined = this
    const result: string[] = []
    do {
      result.push(`    at ${entry.parent.tree.url}#${entry.options.id}`)
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return result
  }

  async init() {
    try {
      await (this._initTask ??= this._init())
    } finally {
      this._initTask = undefined
    }
    this.fiber?.await().finally(() => {
      if (this.loader.getTasks().length) return
      this.ctx.reflect.notify(['loader'])
    })
  }

  private async _init() {
    let exports: any
    try {
      exports = await this.parent.tree.import(this.options.name, this.getOuterStack, true)
    } catch (error) {
      this.context.emit(this.ctx, 'internal/error', error)
      return
    } finally {
      this._initTask = undefined
    }
    const plugin = this.loader.unwrapExports(exports)
    this._patchContext([])
    this.loader.showLog(this, 'apply')
    this.fiber = this.ctx.registry.plugin(plugin, this._resolveConfig(plugin), this.getOuterStack)
  }
}
