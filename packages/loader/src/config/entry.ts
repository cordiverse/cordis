import { Context, Fiber, FiberState, Inject, ValidationError } from 'cordis'
import { deepEqual, Dict, isNullable } from 'cosmokit'
import { Loader } from '../index.ts'
import { EntryGroup } from './group.ts'
import { EntryTree, ModuleNotFoundError } from './tree.ts'
import { evaluate, formatIssues, formatLocation, hasJsExpr, interpolate, isJsExpr, relocate, swap } from './utils.ts'

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

/**
 * The fields an entry evaluates in its own injection scope, as opposed to the
 * parent scope (`inject` values) or the plugin scope (`config`).
 */
const GATED_KEYS: (keyof EntryOptions)[] = ['inject', 'disabled', 'intercept']

export class Entry {
  static readonly key = Symbol.for('cordis.entry')

  public ctx: Context
  public fiber?: Fiber
  public parent!: EntryGroup
  // safety: call `entry.update()` immediately after creating an entry
  public options = {} as EntryOptions
  public subgroup?: EntryGroup
  public subtree?: EntryTree

  /** `inject` values, evaluated in the parent scope. */
  public inject: Dict = Object.create(null)
  /** `intercept`, evaluated in the entry injection scope; `undefined` until then. */
  public intercept?: Dict
  /** The coordinator fiber whose `inject` is this entry's `inject`. */
  public gate?: Fiber

  _initTask?: Promise<void> | undefined
  /** The entry's own `disabled` verdict; `undefined` until it is evaluated. */
  _verdict?: boolean
  /** Whether the last attempt to load the plugin module failed. */
  _failed?: boolean
  /** How many teardowns the loader has in flight for this entry. */
  _disposing = 0
  /** The module fetch, shared by the gate's early start and the load itself. */
  private _module?: { name: string; task: Promise<any> }

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

  /**
   * Whether the entry's plugin must not run. A group is structural: it is
   * created even when its own options would disable a plugin, and the verdict
   * only reaches its children.
   */
  get disabled(): boolean {
    if (this.options.group) return false
    let entry: Entry | undefined = this
    do {
      // without a verdict the entry must not be taken for enabled
      if (entry._verdict !== false) return true
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return false
  }

  evaluate(expr: string) {
    return evaluate(this.ctx, expr)
  }

  /**
   * Whether the entry is known to be disabled. An undecided verdict is not a
   * verdict: a gate that is still waiting for its dependencies must survive a
   * configuration update, so teardown cannot read the strict getter.
   */
  private _knownDisabled(): boolean {
    if (this.options.group) return false
    let entry: Entry | undefined = this
    do {
      if (entry._verdict === true) return true
      if (entry._verdict === undefined) return false
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return false
  }

  /** Evaluate this entry's own `disabled` option. */
  resolveDisabled(ctx = this.parent.ctx): boolean {
    const { disabled } = this.options
    return isJsExpr(disabled)
      ? Boolean(evaluate(ctx, disabled.__jsExpr))
      : Boolean(disabled)
  }

  /** Evaluate this entry's own `intercept` option. */
  resolveIntercept(ctx = this.parent.ctx): Dict | undefined {
    const { intercept } = this.options
    if (!intercept) return
    // values without an expression are already resolved
    return hasJsExpr(intercept) ? interpolate(ctx, intercept) : intercept
  }

  /** Install a resolved `intercept` table on this entry's context. */
  applyIntercept(table: Dict | undefined) {
    this.intercept = table
    swap(this.ctx[Context.intercept], table)
  }

  /** Resolve `inject` values in the parent scope. */
  private _resolveInject(): Dict {
    const { inject } = this.options
    const result = Inject.resolve(inject)
    if (!inject || Array.isArray(inject)) return result
    for (const key of Object.keys(result)) {
      if (isNullable(result[key]) || !hasJsExpr(result[key])) continue
      result[key] = interpolate(this.parent.ctx, result[key])
    }
    return result
  }

  /**
   * A gate is only needed when expressions read the entry's own dependencies:
   * with an empty `inject` the entry scope is the parent scope, and a literal
   * `disabled` has nothing to evaluate.
   */
  private _needsGate() {
    if (!Object.keys(this.inject).length) return false
    if (isJsExpr(this.options.disabled)) return true
    if (this.options.disabled) return false
    return hasJsExpr(this.options.intercept)
  }

  /** Resolve `inject` values in the parent scope, reporting a failure as a verdict. */
  private _resolveScope() {
    try {
      this.inject = this._resolveInject()
      return true
    } catch (error) {
      // the values are part of the entry's identity, so an entry that cannot
      // resolve them does not run; the next trigger re-evaluates it
      this.ctx.logger.error(error)
      this.inject = Object.create(null)
      this._verdict = true
      return false
    }
  }

  /** Evaluate this entry's own `disabled` and `intercept` in the parent scope. */
  private _settle() {
    try {
      this._verdict = this.resolveDisabled(this.parent.ctx)
      this.applyIntercept(this.resolveIntercept(this.parent.ctx))
    } catch (error) {
      // a failure is a verdict: the entry does not run, and the next trigger
      // re-evaluates it like any other expression
      this.ctx.logger.error(error)
      this._verdict = true
    }
  }

  /**
   * Re-evaluate `intercept` in an active gate's scope. A pending gate evaluates
   * the current options itself once its dependencies arrive.
   */
  private _refreshIntercept() {
    const gate = this.gate!
    if (gate.state !== FiberState.ACTIVE) return
    try {
      this.applyIntercept(this.resolveIntercept(gate.ctx))
    } catch (error) {
      this.ctx.logger.error(error)
    }
  }

  private async _patchContext(diff: string[]) {
    await this.context.waterfall('loader/patch-context', this, async () => {
      Object.setPrototypeOf(this.ctx, this.parent.ctx)

      if (this.fiber?.uid && (diff.includes('config') || this.options.group)) {
        await this.fiber.update(this.options.config, true)
      }
    })
  }

  async refresh() {
    if (this.gate || this.fiber?.uid) return
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

    // step 2: the fields the entry evaluates in its own scope
    if (this._verdict === undefined || GATED_KEYS.some(key => !deepEqual(this.options[key], legacy[key]))) {
      const injectChanged = !deepEqual(this.options.inject, legacy.inject)
      const disabledChanged = !deepEqual(this.options.disabled, legacy.disabled)
      if (this._resolveScope()) {
        const needed = this._needsGate()
        // `inject` is the gate's own `d` and the gate owns the plugin fiber, so
        // a change there — or to whether a gate is needed at all, or to the
        // verdict it decides — can only be applied by re-creating the entry
        if (injectChanged || needed !== !!this.gate || (this.gate && disabledChanged)) {
          await this.dispose()
          await this.init()
          return
        }
        // `intercept` is a table read on every lookup, so an active gate can
        // re-evaluate it in place and the plugin does not have to reload
        if (this.gate) {
          this._refreshIntercept()
        } else {
          this._settle()
        }
      }
    }

    // step 3: execute
    if (this._knownDisabled()) {
      this.dispose()
      return
    }

    if (this.fiber?.uid) {
      const diff = Object
        .keys({ ...this.options, ...legacy })
        .filter(key => !deepEqual(this.options[key], legacy[key]))
      if (!diff.length && !force) return
      this.context.emit('loader/partial-dispose', this, legacy, true)
      await this._patchContext(diff)
    } else {
      await this.init()
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
    this.fiber?.await().catch(() => {}).finally(() => {
      if (this.loader.getTasks().length) return
      this.ctx.reflect.notify(['loader'])
    })
  }

  private async _init() {
    // the entry injection scope is the parent scope plus the entry's own
    // resolved `inject`; only the gate can hold the second one
    if (!this._resolveScope()) return
    const gated = this._needsGate()
    if (gated) {
      // a gate already coordinates this entry and evaluates the current options
      // when it runs; creating a second one would leave the first one waiting.
      // A gate whose load failed is the exception: only a fresh one can retry.
      if (this.gate && !this._failed) return
      if (this.gate) await this.dispose()
      this._failed = false
      this.intercept = undefined
      this._verdict = undefined
    } else {
      this._settle()
    }
    await this._patchContext([])
    // the hook runs before anything is created, so an entry it removed would
    // otherwise get a fiber the tree no longer holds a reference to
    if (!this._live()) return

    if (!gated) {
      if (this.disabled) return
      await this.load()
      return
    }

    // the module is fetched while the dependencies are still settling: a
    // dependency constrains when the fiber activates, not when it is fetched
    this._prepare().catch(() => {})
    this.gate = this.ctx.registry.plugin(createGate(this), undefined, this.getOuterStack)
    await this.gate
  }

  /** Whether the tree still holds this entry. */
  private _live() {
    return this.parent.tree.store[this.options.id] === this
  }

  /** Fetch the module once per `name`, so a gate can start it early. */
  private _prepare() {
    if (this._module?.name !== this.options.name) {
      const name = this.options.name
      const task = Promise.resolve().then(() => {
        return this.parent.tree.import(name, this.getOuterStack)
      })
      // a failed fetch is not a result: the next attempt has to try again
      task.catch(() => {
        if (this._module?.task === task) this._module = undefined
      })
      this._module = { name, task }
    }
    return this._module.task
  }

  /** Import the module and create the entry's plugin fiber. */
  async load(ctx = this.ctx) {
    let exports: any
    try {
      exports = await this._prepare()
    } catch (error) {
      this._reportImport(error)
      this._failed = true
      return false
    } finally {
      // the fetch is shared with the gate's early start, not across loads: a
      // reloaded module must be fetched again
      this._module = undefined
    }
    // the fetch is an await point of its own: the entry can be gone by now
    if (!this._live()) return false
    const plugin = this.loader.unwrapExports(exports)
    this.loader.showLog(this, 'apply')
    this.fiber = ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
    this._failed = false
    return true
  }

  dispose() {
    const { gate } = this
    this.gate = undefined
    // the gate owns the plugin fiber, so it takes it down as well
    if (gate) return this._teardown(gate)
    return this._disposeFiber()
  }

  /**
   * `entry.fiber` keeps pointing at the fiber it disposed, so the teardown has
   * to announce itself: a disposal the loader performs must not be mistaken
   * for a plugin disposing itself (which writes `disabled: true` back).
   */
  private async _teardown(fiber: Fiber) {
    this._disposing++
    try {
      await fiber.dispose()
    } finally {
      this._disposing--
    }
  }

  /** Take the plugin fiber down on behalf of the loader. */
  _disposeFiber() {
    const { fiber } = this
    if (fiber) return this._teardown(fiber)
  }
}

/**
 * The coordinator fiber: it is created only when an expression needs the
 * entry's own dependencies, its `inject` is exactly those dependencies, and it
 * owns the plugin fiber so that the plugin starts only after a verdict.
 */
function createGate(entry: Entry) {
  return async function* loaderGate(ctx: Context) {
    let disabled: boolean
    try {
      disabled = entry.resolveDisabled(ctx)
    } catch (error) {
      ctx.logger.error(error)
      // a failure is a verdict, not a sticky state: the gate stays loaded and
      // re-evaluates on the same triggers as any other expression
      entry._verdict = true
      return
    }
    entry._verdict = disabled
    // the verdict is the entry's own, but an enclosing group's verdict reaches
    // it through the same getter: a plugin the tree considers disabled must not
    // start just because its coordinator is the one asking
    if (entry.disabled) return
    // resolve `intercept` only once the entry is enabled: a disabled entry has
    // nothing to intercept, and evaluating it there would report a failure the
    // tree never asked for (#195: "if enabled, resolve and apply `intercept`")
    let intercept: Dict | undefined
    try {
      intercept = entry.resolveIntercept(ctx)
    } catch (error) {
      ctx.logger.error(error)
      entry._verdict = true
      return
    }
    entry.applyIntercept(intercept)
    if (!await entry.load(ctx)) return
    // the gate owns the plugin fiber, so unloading the gate takes it down.
    // The verdict goes first: a dependency-driven teardown is not the entry
    // disabling itself, and the write-back must not run on a stale verdict.
    // The fiber is read late because HMR replaces it without going through the
    // entry, and the replacement is the one that has to go.
    yield () => {
      entry._verdict = undefined
      return entry._disposeFiber()
    }
  }
}
