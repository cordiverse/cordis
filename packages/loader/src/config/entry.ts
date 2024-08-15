import { Context, ForkScope } from '@cordisjs/core'
import { isNullable } from 'cosmokit'
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
}

export interface EntryUpdateMeta {}

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
  public fork?: ForkScope<C>
  public suspend = false
  public parent!: EntryGroup
  public options!: EntryOptions
  public subgroup?: EntryGroup
  public subtree?: EntryTree<C>

  constructor(public loader: Loader<C>) {
    this.ctx = loader.ctx.extend()
    this.context.emit('loader/entry-init', this)
  }

  get context(): Context {
    return this.ctx
  }

  get id() {
    let id = this.options.id
    if (this.parent.tree.ctx.scope.entry) {
      id = this.parent.tree.ctx.scope.entry.id + EntryTree.sep + id
    }
    return id
  }

  get disabled() {
    // group is always enabled
    if (this.options.group) return false
    let entry: Entry | undefined = this
    do {
      if (entry.options.disabled) return true
      entry = entry.parent.ctx.scope.entry
    } while (entry)
    return false
  }

  _check() {
    if (this.disabled) return false
    return !this.parent.ctx.bail('loader/entry-check', this)
  }

  evaluate(expr: string) {
    return evaluate(this.ctx, expr)
  }

  _resolveConfig(plugin: any): [any, any?] {
    if (plugin[EntryGroup.key]) return [this.options.config]
    try {
      return [interpolate(this.ctx, this.options.config)]
    } catch (error) {
      this.context.emit(this.ctx, 'internal/error', error)
      return [null, error]
    }
  }

  patch(options: Partial<EntryOptions> = {}) {
    // step 1: prepare isolate map
    const meta = {} as EntryUpdateMeta
    this.context.emit(meta, 'loader/before-patch', this)

    // step 1: set prototype for transferred context
    Object.setPrototypeOf(this.ctx, this.parent.ctx)

    if (this.fork && 'config' in options) {
      // step 2: update fork (when options.config is updated)
      this.suspend = true
      const [config, error] = this._resolveConfig(this.fork.runtime.plugin)
      if (error) {
        this.fork.cancel(error)
      } else {
        this.fork.update(config)
      }
    } else if (this.subgroup && 'disabled' in options) {
      // step 3: check children (when options.disabled is updated)
      const tree = this.subtree ?? this.parent.tree
      for (const options of this.subgroup.data) {
        tree.store[options.id].update({
          disabled: options.disabled,
        })
      }
    }

    this.context.emit(meta, 'loader/after-patch', this)
  }

  async refresh() {
    const ready = this._check()
    if (ready && !this.fork) {
      await this.start()
    } else if (!ready && this.fork) {
      await this.stop()
    }
  }

  async update(options: Partial<EntryOptions>, override = false) {
    const legacy = { ...this.options }

    // step 1: update options
    if (override) {
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
    if (!this._check()) {
      await this.stop()
    } else if (this.fork) {
      this.context.emit('loader/partial-dispose', this, legacy, true)
      this.patch(options)
    } else {
      await this.start()
    }
  }

  async start() {
    const exports = await this.parent.tree.import(this.options.name).catch((error: any) => {
      this.context.emit(this.ctx, 'internal/error', new Error(`Cannot find package "${this.options.name}"`))
      this.context.emit(this.ctx, 'internal/error', error)
    })
    if (!exports) return
    const plugin = this.loader.unwrapExports(exports)
    this.patch()
    this.ctx[Entry.key] = this
    const [config, error] = this._resolveConfig(plugin)
    this.fork = this.ctx.registry.plugin(plugin, config, error)
    this.context.emit('loader/entry-fork', this, 'apply')
  }

  async stop() {
    this.fork?.dispose()
    this.fork = undefined
  }
}
