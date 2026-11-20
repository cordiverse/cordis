import { Component, Context, Fiber, FiberState, Inject, ValidationError } from 'cordis'
import { deepEqual, Dict, isNullable } from 'cosmokit'
import { Loader } from '../index.ts'
import { EntryGroup } from './group.ts'
import { EntryTree, ModuleNotFoundError } from './tree.ts'
import { patchIsolate } from './isolate.ts'
import { evaluate, ExprTrace, formatIssues, formatLocation, interpolate, isJsExpr, JsExpr, relocate, swap } from './utils.ts'

export interface EntryOptions {
  id: string
  name: string
  config?: any
  group?: boolean | null
  disabled?: boolean | JsExpr | null
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
    const entry = ctx[Entry.key]!
    // re-imported so that a module reloaded by HMR in between is used
    const exports = await entry._import()
    // stops here if a dependency was lost during the import; the verdict was
    // evaluated with the services of this fiber, so it expires with them
    yield () => {
      if (entry.outerFiber?.ctx.fiber === ctx.fiber) entry._verdict = undefined
    }
    if (exports) entry._start(ctx, exports.component)
  },
}

export class Entry {
  static readonly key: unique symbol = Symbol.for('cordis.entry')

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
    this.ctx[Context.isolate] = Object.create(this.ctx[Context.isolate])
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

  get id(): string {
    const owner = this.parent.tree.ctx[Entry.key]
    return owner ? owner.id + EntryTree.sep + this.options.id : this.options.id
  }

  // undefined while the outer fiber is pending
  private _evaluationContext(): Context | undefined {
    if (!this.outerFiber) return this.ctx
    if (this.outerFiber.committed) return this.outerFiber.ctx
  }

  private _resolveDisabled(ctx: Context) {
    const { disabled } = this.options
    try {
      this._verdict = isJsExpr(disabled) ? !!evaluate(ctx, disabled.__jsExpr, this.trace(['disabled'])) : !!disabled
    } catch (error) {
      this.ctx.logger.error(error)
      this._verdict = true
    }
  }

  get disabled() {
    // group is always enabled
    if (this.options.group) return false
    return !this._enabled() || this._parentDisabled()
  }

  /**
   * Whether the verdict enables the entry. A verdict evaluated with the services
   * of the outer fiber does not hold once the fiber starts to unload, e.g. on
   * a dependency loss; the verdict itself is cleared when the unload finishes.
   */
  private _enabled() {
    return this._verdict === false && this.outerFiber?.state !== FiberState.UNLOADING
  }

  private _parentDisabled() {
    let entry = this.parent.ctx[Entry.key]
    while (entry) {
      if (!entry._enabled()) return true
      entry = entry.parent.ctx[Entry.key]
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
        inject[key] = interpolate(this.parent.ctx, inject[key], this.trace, ['inject', key])
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
      swap(this._intercept, interpolate(ctx, this.options.intercept, this.trace, ['intercept']))
      return true
    } catch (error) {
      this.ctx.logger.error(error)
      // the component does not run with an intercept that cannot be evaluated
      this._verdict = true
      return false
    }
  }

  async _patchContext(diff: string[]) {
    await patchIsolate(this, async () => {
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
      // a component that hosts entries, such as a group or an include,
      // leaves the reports to its entries
      const { prototype } = this.innerFiber!.runtime!.callback
      if (!(prototype instanceof EntryGroup || prototype instanceof EntryTree)) {
        this.loader.showLog(this, 'reload')
      }
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

    // the component and the outer fiber are bound when they are created
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

  locateExpr(path: PropertyKey[], expr: string, offset: number) {
    return this.parent.tree.locateExpr(this.options.id, path, expr, offset)
  }

  getOuterStack = () => this.parent.getOuterStack(this.options.id)

  trace = (path: PropertyKey[]): ExprTrace => ({
    label: path.map(String).join('.'),
    locate: (expr, offset) => this.locateExpr(path, expr, offset),
    getOuterStack: this.getOuterStack,
  })

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
      return { component: this.loader.unwrapExports(exports) }
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
      this.outerFiber = this.ctx.registry.use({ ...outer, inject: this.inject }, undefined, {
        getOuterStack: this.getOuterStack,
      })
    } else {
      this._start(this.ctx, exports.component)
    }
  }

  private _registered() {
    return this.parent.tree.store[this.options.id] === this
  }

  _start(ctx: Context, component: Component) {
    if (!this._registered()) return
    // a group still starts; its verdict only reaches its children
    this._resolveDisabled(ctx)
    if (this.disabled || !this._applyIntercept(ctx)) return
    this.loader.showLog(this, 'apply')
    const innerContext = ctx.extend({ [Context.intercept]: this._intercept })
    const entry = this
    this.innerFiber = innerContext.registry.use(component, this.options.config, {
      getOuterStack: this.getOuterStack,
      config(config, resolve) {
        try {
          // a group's config is the entry list itself, which the loader mutates
          // in place and identifies by reference
          if (this.runtime!.callback[EntryGroup.key]) return resolve(config)
          return resolve(interpolate(this.ctx, config, entry.trace, ['config']))
        } catch (error) {
          // a config passed in at runtime is not written anywhere yet
          if (ValidationError.is(error) && config === entry.options.config) entry.traceValidation(error)
          throw error
        }
      },
      commit(config) {
        const unparse = this.runtime?.Config?.['simplify']
        const legacy = { ...entry.options }
        entry.options.config = unparse ? unparse(config) : config
        entry.parent.tree.commit({ id: entry.options.id, group: entry.parent, options: entry.options, legacy })
      },
      dispose() {
        entry._onDispose(this)
      },
    })
  }

  /** Called when the inner fiber starts to be disposed. */
  private _onDispose(fiber: Fiber) {
    // case 1: the tree of the entry is being disposed
    if (!this.parent.tree.ctx.fiber.uid) return

    this.loader.showLog(this, 'unload')

    // case 2: the parent of the entry is being unloaded, which takes the entry
    // with it (the parent may still be registered, e.g. when it has lost a dependency)
    if (fiber.parent.fiber.state === FiberState.UNLOADING) return

    // case 3: the entry is being removed (`EntryGroup.remove` unregisters it
    // before disposing the fiber)
    if (!this._registered()) return

    // case 4: the fiber is disposed through `entry.dispose()`, e.g. on a config
    // file update, an ancestor group being disabled, or a rebuild
    if (this._disposing) return

    // otherwise, the component disposes itself: disable the entry
    const legacy = { ...this.options }
    this.options.disabled = true
    this._verdict = true
    this.parent.tree.commit({ id: this.options.id, group: this.parent, options: this.options, legacy })
    if (this.outerFiber) this.dispose()
  }
}
