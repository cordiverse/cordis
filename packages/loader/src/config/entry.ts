import { Context, Fiber, FiberState, Inject, Plugin, ValidationError } from 'cordis'
import { deepEqual, Dict, isNullable } from 'cosmokit'
import { Loader } from '../index.ts'
import { EntryGroup } from './group.ts'
import { EntryTree, ModuleNotFoundError } from './tree.ts'
import { evaluate, formatIssues, formatLocation, interpolate, isJsExpr, relocate, swap } from './utils.ts'

export interface EntryOptions {
  id: string
  name: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: Inject | null
  intercept?: Dict | null
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

// holds the entry's `inject` and creates the inner fiber as its child
const outer = {
  name: 'loader:outer',
  async* apply(ctx: Context) {
    const entry: Entry = ctx[Entry.key]
    // re-imported so that a module reloaded by HMR in between is used
    const exports = await entry._import()
    // stops here if a dependency was lost during the import
    yield () => {}
    if (exports) entry._start(ctx, exports.plugin)
  },
}

export class Entry {
  static readonly key = Symbol.for('cordis.entry')

  static isOuter(fiber: Fiber) {
    return fiber.runtime?.callback === outer.apply
  }

  public ctx: Context
  public outerFiber?: Fiber
  public innerFiber?: Fiber
  public parent!: EntryGroup
  // safety: call `entry.update()` immediately after creating an entry
  public options = {} as EntryOptions
  public subgroup?: EntryGroup
  public subtree?: EntryTree
  public inject: Dict = Object.create(null)

  _initTask?: Promise<void> | undefined
  _disposing = false
  _verdict?: boolean
  private _intercept: Dict = Object.create(null)

  constructor(public loader: Loader) {
    this.ctx = loader.ctx.extend({ [Entry.key]: this })
    this.context.emit('loader/entry-init', this)
  }

  static merge(target: Partial<EntryOptions>, options: Partial<EntryOptions>) {
    for (const [key, value] of Object.entries(options)) {
      if (isNullable(value)) {
        delete target[key]
      } else {
        target[key] = value
      }
    }
    return target
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

  // undefined while the outer fiber is pending
  private _evaluationContext(): Context | undefined {
    if (!this.outerFiber) return this.ctx
    if (this.outerFiber.committed) return this.outerFiber.ctx
  }

  private _resolveDisabled(ctx: Context) {
    const { disabled } = this.options
    try {
      this._verdict = isJsExpr(disabled) ? !!evaluate(ctx, disabled.__jsExpr) : !!disabled
    } catch (error) {
      this.ctx.logger.error(error)
      this._verdict = true
    }
  }

  get disabled() {
    // group is always enabled
    if (this.options.group) return false
    return this._verdict !== false || this._parentDisabled()
  }

  private _parentDisabled() {
    let entry = this.parent.ctx.fiber.entry
    while (entry) {
      if (entry._verdict !== false) return true
      entry = entry.parent.ctx.fiber.entry
    }
    return false
  }

  private _blocked() {
    if (this.options.group) return false
    // an expression waits for the patched context
    if (!isJsExpr(this.options.disabled) && this.options.disabled) {
      this._verdict = true
      return true
    }
    return this._parentDisabled()
  }

  evaluate(expr: string) {
    const ctx = this._evaluationContext()
    if (!ctx) throw new Error(`entry ${this.id} is waiting for its dependencies`)
    return evaluate(ctx, expr)
  }

  private _hasOuter() {
    return Object.keys(this.inject).length > 0
  }

  // returns whether `inject` changed, or undefined on failure
  private _resolveInject(): boolean | undefined {
    let inject: Dict
    try {
      inject = Inject.resolve(this.options.inject)
      for (const key of Object.keys(inject)) {
        inject[key] = interpolate(this.parent.ctx, inject[key])
      }
    } catch (error) {
      this.ctx.logger.error(error)
      this.inject = Object.create(null)
      this._verdict = true
      return
    }
    // strict: `null` and a missing key differ
    const changed = !deepEqual(inject, this.inject, true)
    this.inject = inject
    return changed
  }

  private _applyIntercept(ctx: Context) {
    try {
      swap(this._intercept, interpolate(ctx, this.options.intercept))
      return true
    } catch (error) {
      this.ctx.logger.error(error)
      // the plugin does not run with an intercept that cannot be evaluated
      this._verdict = true
      return false
    }
  }

  private async _patchContext(diff: string[]) {
    await this.context.waterfall('loader/patch-context', this, async () => {
      Object.setPrototypeOf(this.ctx, this.parent.ctx)
      Object.setPrototypeOf(this._intercept, this.parent.ctx[Context.intercept])

      if (this.outerFiber) {
        if (this.outerFiber.state !== FiberState.ACTIVE) return
        await this._reconcile(this.outerFiber.ctx, diff)
      } else if (this.innerFiber?.uid) {
        await this._reconcile(this.ctx, diff)
      }
    })
  }

  private async _reconcile(ctx: Context, diff: string[]) {
    if (!this.innerFiber?.uid) {
      // the reactivation evaluates `disabled`
      await this.outerFiber?.restart()
      return
    }
    this._resolveDisabled(ctx)
    if (this.disabled || !this._applyIntercept(ctx)) {
      this._dispose(this.innerFiber)
      return
    }
    if (diff.includes('config') || this.options.group) {
      await this.innerFiber!.update(this.options.config, true)
    }
  }

  async refresh() {
    if (this.outerFiber || this.innerFiber) return
    if (this._resolveInject() === undefined) return
    if (this._blocked()) return
    await this.init()
  }

  async update(options: Partial<EntryOptions>, create = false, force = false) {
    const legacy = { ...this.options }

    // step 1: update options
    if (create) {
      this.options = options as EntryOptions
    } else {
      Entry.merge(this.options, options)
    }
    sortKeys(this.options)

    // step 2: resolve inject
    const changed = this._resolveInject()
    if (changed === undefined) {
      this.dispose()
      return
    }

    // step 3: execute
    if (this._blocked()) {
      this.dispose()
      return
    }

    // the plugin and the outer fiber are bound when they are created
    const rebuild = changed || this.options.name !== legacy.name
    if (rebuild || (!this.outerFiber && !this.innerFiber?.uid)) {
      // the disposal is part of the init task, so a concurrent update joins it
      await this.init(this.outerFiber || this.innerFiber?.uid ? this.dispose() : undefined)
      return
    }

    // step 4: check if options are changed
    const diff = Object
      .keys({ ...this.options, ...legacy })
      .filter(key => !deepEqual(this.options[key], legacy[key]))
    if (!diff.length && !force) return
    this.context.emit('loader/partial-dispose', this, legacy, true)
    await this._patchContext(diff)
  }

  dispose() {
    const fiber = this.outerFiber ?? this.innerFiber
    this.outerFiber = undefined
    return this._dispose(fiber)
  }

  private _dispose(fiber?: Fiber) {
    this._disposing = true
    try {
      return fiber?.dispose()
    } finally {
      this._disposing = false
    }
  }

  getLocation(path: PropertyKey[] = []) {
    return this.parent.tree.getLocation(this.options.id, path)
  }

  getOuterStack = () => this.parent.getOuterStack(this.options.id)

  traceValidation(error: ValidationError) {
    const frames = this.getOuterStack()
    // an entry outside any source has nothing to point to
    if (!frames.length) return
    const issues = error.issues.map(({ message, path }) => ({ message, path: ValidationError.normalizePath(path) }))
    const locate = (path: PropertyKey[]) => this.getLocation(['config', ...path])
    relocate(error, formatIssues('invalid config', issues, locate), frames)
  }

  private _reportImport(error: unknown) {
    if (error instanceof ModuleNotFoundError) {
      const location = this.getLocation(['name'])
      if (location) {
        // before Node's hints
        const [first, ...hints] = error.message.split('\n')
        relocate(error, [`${first} (at name, ${formatLocation(location)})`, ...hints].join('\n'), this.getOuterStack())
      }
    }
    this.ctx.logger.error(error)
  }

  async init(disposeTask?: Promise<void>) {
    const task = this._initTask ??= this._init(disposeTask)
    try {
      await task
    } finally {
      // `_init()` releases the task before creating fibers, whose apply may start another
      if (this._initTask === task) this._initTask = undefined
    }
    // failures are already reported by the fiber; we only need it to settle
    Promise.resolve()
      .then(() => this.outerFiber?.await())
      .then(() => this.innerFiber?.await())
      .catch(() => {})
      .finally(() => {
        if (this.loader.getTasks().length) return
        this.ctx.reflect.notify(['loader'])
      })
  }

  async _import() {
    try {
      const exports = await this.parent.tree.import(this.options.name, this.getOuterStack)
      return { plugin: this.loader.unwrapExports(exports) }
    } catch (error) {
      this._reportImport(error)
    }
  }

  private async _init(disposeTask?: Promise<void>): Promise<void> {
    await disposeTask
    // a later update has already rebuilt the entry
    if (this.outerFiber || this.innerFiber?.uid) return
    this._verdict = undefined
    const { name } = this.options
    const exports = await this._import()
    // the name may change while the module is imported
    if (name !== this.options.name) return this._init()
    if (!exports || !this._registered() || this._blocked()) return
    await this._patchContext([])
    if (name !== this.options.name) return this._init()
    if (!this._registered() || this._blocked()) return
    this._initTask = undefined
    if (this._hasOuter()) {
      this.outerFiber = this.ctx.registry.plugin({ ...outer, inject: this.inject }, undefined, this.getOuterStack)
    } else {
      this._start(this.ctx, exports.plugin)
    }
  }

  private _registered() {
    return this.parent.tree.store[this.options.id] === this
  }

  _start(ctx: Context, plugin: Plugin) {
    if (!this._registered()) return
    // a group still starts; its verdict only reaches its children
    this._resolveDisabled(ctx)
    if (this.disabled || !this._applyIntercept(ctx)) return
    this.loader.showLog(this, 'apply')
    const innerContext = ctx.extend({ [Context.intercept]: this._intercept })
    this.innerFiber = innerContext.registry.plugin(plugin, this.options.config, this.getOuterStack)
  }
}
