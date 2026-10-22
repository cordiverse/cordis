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
    if (exports) entry._activate(ctx, exports.plugin)
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
  private _scope(): Context | undefined {
    if (!this.outerFiber) return this.ctx
    if (this.outerFiber.committed) return this.outerFiber.ctx
  }

  private _resolveDisabled(scope: Context) {
    const { disabled } = this.options
    try {
      this._verdict = isJsExpr(disabled) ? !!evaluate(scope, disabled.__jsExpr) : !!disabled
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
    const scope = this._scope()
    if (!scope) throw new Error(`entry ${this.id} is waiting for its dependencies`)
    return evaluate(scope, expr)
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

  private _applyIntercept(scope: Context) {
    try {
      swap(this._intercept, interpolate(scope, this.options.intercept))
      return true
    } catch (error) {
      this.ctx.logger.error(error)
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

  private async _reconcile(scope: Context, diff: string[]) {
    if (!this.innerFiber?.uid) {
      // the reactivation evaluates `disabled`
      await this.outerFiber?.restart()
      return
    }
    this._resolveDisabled(scope)
    if (this.disabled) {
      this._dispose(this.innerFiber)
      return
    }
    this._applyIntercept(scope)
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
    const rebuild = this._resolveInject()
    if (rebuild === undefined) {
      this.dispose()
      return
    }

    // step 3: execute
    if (this._blocked()) {
      this.dispose()
      return
    }

    if (rebuild || (!this.outerFiber && !this.innerFiber?.uid)) {
      // avoid an await before `init()` sets `_initTask`
      if (this.outerFiber || this.innerFiber?.uid) await this.dispose()
      await this.init()
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

  async init() {
    try {
      await (this._initTask ??= this._init())
    } finally {
      this._initTask = undefined
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

  private async _init() {
    this._verdict = undefined
    const exports = await this._import()
    if (!exports || !this._live() || this._blocked()) return
    await this._patchContext([])
    if (!this._live() || this._blocked()) return
    if (this._hasOuter()) {
      this.outerFiber = this.ctx.registry.plugin({ ...outer, inject: this.inject }, undefined, this.getOuterStack)
    } else {
      this._activate(this.ctx, exports.plugin)
    }
  }

  private _live() {
    return this.parent.tree.store[this.options.id] === this
  }

  _activate(scope: Context, plugin: Plugin) {
    if (!this._live()) return
    // a group still starts; its verdict only reaches its children
    this._resolveDisabled(scope)
    if (this.disabled) return
    this._start(scope, plugin)
  }

  private _start(scope: Context, plugin: Plugin) {
    if (!this._applyIntercept(scope)) {
      this._verdict = true
      return
    }
    this.loader.showLog(this, 'apply')
    const ctx = scope.extend({ [Context.intercept]: this._intercept })
    this.innerFiber = ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
  }
}
