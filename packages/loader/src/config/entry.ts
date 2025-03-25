import { Context, EffectScope } from '@cordisjs/core'
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
  public scope?: EffectScope<C>
  public suspend = false
  public parent!: EntryGroup<C>
  public options!: EntryOptions
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

  evaluate(expr: string) {
    return evaluate(this.ctx, expr)
  }

  _resolveConfig(plugin: any): [any, any?] {
    if (plugin[EntryGroup.key]) return this.options.config
    return interpolate(this.ctx, this.options.config)
  }

  private _patchContext(options: Partial<EntryOptions> = {}) {
    this.context.waterfall('loader/patch-context', this, () => {
      // step 1: set prototype for transferred context
      Object.setPrototypeOf(this.ctx, this.parent.ctx)

      if (this.scope && 'config' in options) {
        // step 2: update fork (when options.config is updated)
        this.suspend = true
        this.scope.update(this._resolveConfig(this.scope.runtime?.callback))
      } else if (this.subgroup && 'disabled' in options) {
        // step 3: check children (when options.disabled is updated)
        const tree = this.subtree ?? this.parent.tree
        for (const options of this.subgroup.data) {
          tree.store[options.id].update({
            disabled: options.disabled,
          })
        }
      }
    })
  }

  check() {
    return !this.disabled && !this.context.bail('loader/entry-check', this)
  }

  async refresh() {
    if (this.scope) return
    if (!this.check()) return
    await (this._initTask ??= this._init())
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
    // this._check() is only a init-time optimization
    if (this.disabled) {
      this.scope?.dispose()
      return
    }

    if (this.scope?.uid) {
      this.context.emit('loader/partial-dispose', this, legacy, true)
      this._patchContext(options)
    } else {
      // FIXME: lock init task
      await (this._initTask = this._init())
    }
  }

  getOuterStack = () => {
    let entry: Entry<C> | undefined = this
    const result: string[] = []
    do {
      result.push(`    at ${entry.parent.tree.url}#${entry.options.id}`)
      entry = entry.parent.ctx.scope.entry
    } while (entry)
    return result
  }

  private async _init() {
    let exports: any
    try {
      exports = await this.parent.tree.import(this.options.name, this.getOuterStack, true)
    } catch (error) {
      this.context.emit(this.ctx, 'internal/error', error)
      return
    }
    const plugin = this.loader.unwrapExports(exports)
    this._patchContext()
    this.loader.showLog(this, 'apply')
    this.scope = this.ctx.registry.plugin(plugin, this._resolveConfig(plugin), this.getOuterStack)
    this._initTask = undefined
  }
}
