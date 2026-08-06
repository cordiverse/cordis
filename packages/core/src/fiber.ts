import { Awaitable, defineProperty, Dict, isNullable, noop } from 'cosmokit'
import { Context } from './context'
import { Plugin } from './registry'
import { buildOuterStack, composeError, DisposableList, getTraceable, isConstructor, isObject, isPromiseLike, symbols } from './utils'
import { Impl } from './reflect'
import { StandardSchemaV1 } from '@standard-schema/spec'

declare module './context' {
  export interface Context extends Pick<Fiber, 'effect'> {
    fiber: Fiber
  }
}

const kValidationError = Symbol.for('ValidationError')

export class ValidationError extends TypeError {
  name = 'ValidationError'

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(`invalid config:\n` + issues.map(issue => {
      if (issue.path) {
        return `  - ${issue.message} (at ${issue.path.join('.')})`
      } else {
        return `  - ${issue.message}`
      }
    }).join('\n'))
  }
}

Object.defineProperty(ValidationError.prototype, kValidationError, {
  value: true,
})

export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config
  // TODO: async validation
  const result = runtime.Config['~standard'].validate(config)
  if ('then' in result) {
    throw new TypeError('Async config validation is not supported')
  }
  if (result.issues) {
    throw new ValidationError(result.issues)
  } else {
    return result.value
  }
}

interface AsyncDisposable<T extends Awaitable<void> = Awaitable<void>> extends PromiseLike<() => T> {
  (): T
}

export type Disposable<T = any> = () => T

export type Effect<T = any> =
  | SyncEffect<T>
  | AsyncEffect<T>

type SyncEffect<T = any> =
  | Disposable<T>
  | Iterable<Disposable<T>, void, void>

type AsyncEffect<T = any> =
  | Promise<Disposable<T>>
  | AsyncIterable<Disposable<T>, void, void>

export interface EffectMeta {
  label: string
  children: EffectMeta[]
}

interface EffectRunner<T> {
  epoch: T
  execute: () => any
  collect: (dispose: Disposable) => void
  getOuterStack: () => string[]
}

interface DesiredSnapshot {
  loadable: boolean
  config: any
  implementations: Impl[]
}

// Loadable epochs are opaque generation tokens. Desired-state equality is
// tracked separately so an A -> B -> A transition cannot revive work from A.
type FiberEpoch = object | typeof INACTIVE

function combineCleanupErrors(errors: unknown[]) {
  // Do not flatten user AggregateErrors: one cleanup callback owns one error.
  if (!errors.length) return
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, 'multiple cleanup errors')
}

function dispatchFiberDisposal(context: Context, fiber: Fiber) {
  // Disposal observers are diagnostic, not structural owners. Their failures
  // are reported but never delay or reject the Fiber's own disposal.
  const args: any[] = ['internal/plugin', fiber]
  let callbacks: Function[]
  try {
    callbacks = context.events.dispatch('emit', args)
  } catch (error) {
    context.logger.error(error)
    return
  }

  for (const callback of callbacks) {
    try {
      const result = callback(...args)
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(error => context.logger.error(error))
      }
    } catch (error) {
      context.logger.error(error)
    }
  }
}

export const enum FiberState {
  PENDING,
  LOADING,
  ACTIVE,
  FAILED,
  DISPOSED,
  UNLOADING,
}

export class CordisError extends Error {
  constructor(public code: CordisError.Code, message?: string) {
    super(message ?? CordisError.Code[code])
  }
}

export namespace CordisError {
  export type Code = keyof typeof Code

  export const Code = {
    INACTIVE_EFFECT: 'cannot create effect on inactive context',
  } as const
}

const INACTIVE = Symbol.for('cordis.inactive')

type EffectExecutionState = 'running' | 'pending' | 'fulfilled' | 'rejected'

interface ExecutionGate {
  promise: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
}

const kEffectRecord = Symbol.for('cordis.effectRecord')

type ManagedDisposable = Disposable & { [kEffectRecord]?: EffectRecord }

function getEffectRecord(dispose: Disposable) {
  return (dispose as ManagedDisposable)[kEffectRecord]
}

interface CleanupFailure {
  error: unknown
  source?: EffectRecord
}

class EffectRecord {
  readonly meta: EffectMeta
  readonly runner: EffectRunner<boolean>
  readonly dispose: Disposable<Promise<void>>
  readonly wrapper: AsyncDisposable<Promise<void>>

  private cleanups: Disposable[] = []
  private cleanupFailures: CleanupFailure[] = []
  private cleanupReported = false
  private executionState: EffectExecutionState = 'running'
  private executionError: unknown
  private executionTask?: Promise<void>
  private executionGate?: ExecutionGate
  private disposalTask?: Promise<void>
  private removeWrapper: () => boolean

  constructor(private owner: Fiber, execute: () => Effect, label: string) {
    this.meta = { label, children: [] }
    this.runner = {
      execute,
      epoch: true,
      collect: dispose => this.collect(dispose),
      getOuterStack: buildOuterStack(),
    }
    this.dispose = () => this.startDisposal()
    this.wrapper = defineProperty(() => this.startDisposal(), symbols.effect, this.meta) as AsyncDisposable<Promise<void>>
    defineProperty(this.wrapper, kEffectRecord, this)
    this.wrapper.then = (onFulfilled, onRejected) => {
      return this.waitForExecution().then(() => this.dispose).then(onFulfilled, onRejected)
    }
    // Establish ownership before execution can enter user code. A reentrant
    // owner restart can now capture this wrapper in its unload snapshot.
    this.removeWrapper = owner._disposables.push(this.wrapper)
  }

  private collect(dispose: Disposable) {
    this.cleanups.push(dispose)
    this.owner._disposables.delete(dispose)
    if (dispose[symbols.effect]) this.meta.children.push(dispose[symbols.effect])
  }

  private waitForExecution() {
    if (this.executionState === 'fulfilled') return Promise.resolve()
    if (this.executionState === 'rejected') return Promise.reject(this.executionError)
    if (this.executionTask) return this.executionTask
    if (!this.executionGate) {
      // Synchronous execution normally allocates no promise. The gate is
      // created only when disposal actually reenters before execution returns.
      let resolve!: () => void
      let reject!: (reason: unknown) => void
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      promise.catch(noop)
      this.executionGate = { promise, resolve, reject }
    }
    return this.executionGate.promise
  }

  settleExecution(task: void | Promise<void>) {
    if (!isPromiseLike(task)) {
      this.executionState = 'fulfilled'
      this.executionGate?.resolve()
      return
    }
    this.executionState = 'pending'
    // Keep one execution task for both the thenable effect API and disposal
    // that starts while asynchronous execution is pending.
    this.executionTask = Promise.resolve(task).then(() => {
      this.executionState = 'fulfilled'
      this.executionGate?.resolve()
    }, (reason) => {
      this.failExecution(reason, true)
      throw reason
    })
    this.executionTask.catch(noop)
  }

  failExecution(reason: unknown, report = false) {
    this.executionState = 'rejected'
    this.executionError = reason
    this.executionGate?.reject(reason)
    if (report) this.owner.ctx.logger.error(reason)
    // Execution and disposal are separate result channels. The execution
    // error is delivered by throw/the thenable; structural owners only join
    // cleanup and observe cleanup failures.
    this.startDisposal().catch(error => this.reportCleanupFailures(error))
  }

  private runCleanups() {
    const failures = this.cleanupFailures
    const pending = this.cleanups.splice(0).reverse()
    let index = 0

    const next = (): void | Promise<void> => {
      while (index < pending.length) {
        const dispose = pending[index++]
        try {
          const result = dispose()
          if (isPromiseLike(result)) {
            // Preserve strict LIFO ordering across async cleanup. Rejections
            // are recorded and do not veto the remaining cleanup callbacks.
            return Promise.resolve(result).then(next, (error) => {
              const failure = { error, source: getEffectRecord(dispose) }
              failures.push(failure)
              return next()
            })
          }
        } catch (error) {
          const failure = { error, source: getEffectRecord(dispose) }
          failures.push(failure)
        }
      }
    }

    const result = next()
    return isPromiseLike(result) ? Promise.resolve(result).then(() => failures) : failures
  }

  private finishDisposal() {
    const finalize = (failures: CleanupFailure[]) => {
      const error = combineCleanupErrors(failures.map(failure => failure.error))
      return error ? Promise.reject<void>(error) : Promise.resolve()
    }
    const result = this.runCleanups()
    if (isPromiseLike(result)) return { task: Promise.resolve(result).then(finalize), synchronous: false }
    return { task: finalize(result), synchronous: true }
  }

  private startDisposal() {
    // Public callers and structural owners always join the first task; cleanup
    // itself is exactly-once.
    if (this.disposalTask) return this.disposalTask
    this.runner.epoch = false

    let task: Promise<void>
    let synchronous = false
    if (this.executionState === 'fulfilled' || this.executionState === 'rejected') {
      ;({ task, synchronous } = this.finishDisposal())
    } else {
      task = this.waitForExecution().then(
        () => this.finishDisposal().task,
        () => this.finishDisposal().task,
      )
    }

    if (synchronous && !this.owner.inertia) {
      // Outside an owner transition, fully synchronous cleanup can retire the
      // wrapper immediately. During unload it stays joinable until settlement.
      this.removeWrapper()
      this.disposalTask = task
    } else {
      this.disposalTask = task.then(
        () => { this.removeWrapper() },
        (error) => {
          this.removeWrapper()
          throw error
        },
      )
    }
    this.disposalTask.catch(noop)
    return this.disposalTask
  }

  reportCleanupFailures(fallback?: unknown) {
    if (this.cleanupReported) return
    this.cleanupReported = true
    if (!this.cleanupFailures.length) {
      if (fallback !== undefined) this.owner.ctx.logger.error(fallback)
      return
    }
    for (const failure of this.cleanupFailures) {
      if (failure.source) {
        failure.source.reportCleanupFailures(failure.error)
      } else {
        this.owner.ctx.logger.error(failure.error)
      }
    }
  }
}

export class Fiber {
  public uid: number | null
  public readonly ctx: Context
  public config: any
  public state = FiberState.PENDING
  public readonly dispose: () => Promise<void>
  public store: Dict<Impl> | undefined
  public inertia: Promise<void> | undefined

  public readonly _hooks: Dict<DisposableList<Function>> = Object.create(null)
  public readonly _disposables = new DisposableList<Disposable>()

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context

  private _error: any
  private _configError: unknown
  private _runner: EffectRunner<FiberEpoch>
  private _store: Dict<Impl> = Object.create(null)
  private _desired?: DesiredSnapshot

  constructor(
    public parent: Context,
    config: any,
    public inject: Dict<any>,
    public runtime: Plugin.Runtime | null,
    getOuterStack: () => string[],
  ) {
    const collect = (dispose: Disposable) => {
      this._disposables.push(dispose)
    }

    if (runtime) {
      this.uid = parent.registry.counter
      this.ctx = this.context = parent.extend({ fiber: this })

      const injectEntries = Object.entries(this.inject)
      if (injectEntries.length) {
        this.ctx[Context.intercept] = Object.create(parent[Context.intercept])
        for (const [name, config] of injectEntries) {
          if (isNullable(config)) continue
          this.ctx[Context.intercept][name] = config
        }
      }

      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: function () {
          if (isConstructor(runtime.callback)) {
            // eslint-disable-next-line new-cap
            const instance = new runtime.callback(this.ctx, this.config)
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook()
            }
            return instance?.[symbols.init]?.()
          } else {
            return runtime.callback(this.ctx, this.config)
          }
        },
        collect,
      }

      let shouldRefresh = false
      // A child is represented as an effect owned by its parent. This creates
      // child.dispose and runtime ownership before publication runs listeners.
      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this)
        try {
          this.config = resolveConfig(runtime, config)
          shouldRefresh = true
        } catch (error) {
          this.ctx.logger.error(error)
          this._error = this._configError = error
        }
        return async () => {
          this.uid = null
          dispatchFiberDisposal(this.context, this)
          if (this.ctx.registry.has(runtime.callback)) {
            remove()
            if (!runtime.fibers.length) {
              this.ctx.registry.delete(runtime.callback)
            }
          }
          this._setEpoch(INACTIVE)
          if (!this.inertia) {
            this._updateState(() => {
              this.inertia = this._observeLifecycleTask(this._unload())
              return FiberState.UNLOADING
            })
          }
          while (this.inertia) await this.inertia
        }
      }, 'ctx.plugin()')

      try {
        // Publication is fail-fast, but ownership already exists, allowing the
        // catch path to synchronously terminalize and begin rollback.
        this.context.emit('internal/plugin', this)
      } catch (error) {
        this.dispose().catch(reason => this.ctx.logger.error(reason))
        throw error
      }

      if (this.uid !== null && parent.fiber.state !== FiberState.UNLOADING) {
        for (const name of Object.keys(this.inject)) {
          this._checkImpl(name)
        }
        if (shouldRefresh) {
          this._refresh()
        } else if (this._error) {
          this._updateState(() => FiberState.FAILED)
        }
      }
    } else {
      this.uid = 0
      this.ctx = this.context = parent
      this.state = FiberState.ACTIVE
      this.store = Object.create(null)
      this._runner = {
        epoch: {},
        getOuterStack,
        execute: () => {},
        collect,
      }
      this.dispose = () => this.restart()
    }
  }

  get name() {
    let fiber: Fiber = this
    do {
      if (fiber.runtime?.name) return fiber.runtime.name
      fiber = fiber.parent.fiber
    } while (fiber !== fiber.parent.fiber)
    return 'root'
  }

  assertActive() {
    if (this.uid !== null) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  private _execute<T>(runner: EffectRunner<T>) {
    const oldEpoch = runner.epoch
    return composeError((info) => {
      const safeCollect = (dispose: void | Disposable) => {
        if (typeof dispose === 'function') {
          runner.collect(dispose)
        } else if (!isNullable(dispose)) {
          throw new TypeError('Invalid effect')
        }
      }
      const effect: Effect = runner.execute.call(this)
      if (typeof effect === 'function') {
        return runner.collect(effect)
      } else if (isNullable(effect)) {
        // return
      } else if (!isObject(effect)) {
        throw new TypeError('Invalid effect')
      } else if ('then' in effect) {
        return effect.then(safeCollect)
      } else if (Symbol.iterator in effect) {
        info.error = new Error()
        const iter = effect[Symbol.iterator]()
        while (true) {
          const result = iter.next()
          safeCollect(result.value)
          if (result.done) return
        }
      } else if (Symbol.asyncIterator in effect) {
        const iter = effect[Symbol.asyncIterator]()
        return (async () => {
          // force async stack trace
          await Promise.resolve()
          info.error = new Error()
          while (true) {
            if (runner.epoch !== oldEpoch) return
            const result = await iter.next()
            safeCollect(result.value)
            if (result.done) return
          }
        })()
      } else {
        throw new TypeError('Invalid effect')
      }
    }, runner.getOuterStack)
  }

  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  effect(execute: () => Effect, label = 'anonymous'): any {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    if (fiber.state === FiberState.UNLOADING) {
      throw new CordisError('INACTIVE_EFFECT')
    }
    const record = new EffectRecord(fiber, execute, label)
    let task: void | Promise<void>
    try {
      task = fiber._execute(record.runner)
    } catch (reason) {
      record.failExecution(reason)
      throw reason
    }
    record.settleExecution(task)
    return record.wrapper
  }

  getEffects() {
    return [...this._disposables]
      .map<EffectMeta>(dispose => dispose[symbols.effect])
      .filter(Boolean)
  }

  private _getState() {
    if (this.uid === null) return FiberState.DISPOSED
    if (this._error) return FiberState.FAILED
    if (this._runner.epoch !== INACTIVE) return FiberState.ACTIVE
    return FiberState.PENDING
  }

  private _updateState(callback: () => void | FiberState) {
    const oldState = this.state
    this.state = callback() ?? this._getState()
    if (oldState === this.state) return
    // FIXME internal/fiber-info
    this.context.emit('internal/status', this, oldState)

    // only notify changes between ACTIVE and NON-ACTIVE states
    if (oldState !== FiberState.ACTIVE && this.state !== FiberState.ACTIVE) return
    for (const key of Reflect.ownKeys(this.ctx.reflect.store)) {
      const impl = this.ctx.reflect.store[key as symbol]
      if (impl.fiber !== this) continue
      this.ctx.reflect.notify([impl.name])
    }
  }

  _checkImpl(name: string) {
    const impl = this.ctx.reflect._getImpl(name, true)
    if (!impl) return delete this._store[name]
    try {
      if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value))) {
        return delete this._store[name]
      }
    } catch (error) {
      impl.fiber.ctx.logger.error(error)
      return delete this._store[name]
    }
    this._store[name] = impl
  }

  private _observeLifecycleTask(task: Promise<void>) {
    // Attach an observer so internally scheduled transitions never become
    // process-level unhandled rejections. Return the original task unchanged;
    // fiber.await() can still observe the same rejection.
    task.catch(noop)
    return task
  }

  private _isSameDesired(snapshot: DesiredSnapshot) {
    const current = this._desired
    if (!current || current.loadable !== snapshot.loadable || current.config !== snapshot.config) return false
    if (current.implementations.length !== snapshot.implementations.length) return false
    return current.implementations.every((impl, index) => impl === snapshot.implementations[index])
  }

  _refresh(force = false) {
    if (this.uid === null) return
    const implementations: Impl[] = []
    // Dependency availability cannot recover an invalid configuration. Only a
    // successfully validated explicit update clears _configError.
    let loadable = this._configError === undefined
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) {
        loadable = false
        break
      }
      implementations.push(impl)
    }

    const desired = { loadable, config: this.config, implementations }
    // Equal notifications coalesce, while force (restart/config update) always
    // allocates a fresh token even when the snapshot is structurally equal.
    if (!force && this._isSameDesired(desired)) return
    this._desired = desired
    this._setEpoch(loadable ? {} : INACTIVE)
  }

  private _setEpoch(epoch: FiberEpoch) {
    const oldEpoch = this._runner.epoch
    if (epoch === oldEpoch) return
    this._runner.epoch = epoch
    if (epoch !== INACTIVE) this._error = undefined
    // An in-flight transition owns the serialized pump. Updating the token is
    // enough; it will read the latest target after execution/cleanup settles.
    if (this.inertia) return
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._observeLifecycleTask(this._reload())
        return FiberState.LOADING
      } else {
        this.inertia = this._observeLifecycleTask(this._unload())
        return FiberState.UNLOADING
      }
    })
  }

  private async _reload() {
    this.store = { ...this._store }
    const oldEpoch = this._runner.epoch
    let executionError: unknown
    try {
      // Give synchronous invalidation a checkpoint before plugin user code.
      await Promise.resolve()
      if (this._runner.epoch === oldEpoch) {
        await this._execute(this._runner)
      }
    } catch (reason) {
      this.ctx.logger.error(reason)
      // A stale execution may be diagnosed, but it must not overwrite current
      // generation's error or target token.
      if (this._runner.epoch === oldEpoch) {
        executionError = reason
        this._runner.epoch = INACTIVE
      }
    }
    this._updateState(() => {
      if (executionError !== undefined) {
        this.inertia = this._observeLifecycleTask(this._unload(executionError))
        return FiberState.UNLOADING
      }
      if (this._runner.epoch === oldEpoch) {
        this.inertia = undefined
      } else {
        this.inertia = this._observeLifecycleTask(this._unload())
        return FiberState.UNLOADING
      }
    })
  }

  private async _unload(executionError?: unknown) {
    // Top-level effects clean up concurrently. Each rejection is contained at
    // the structural boundary, so Promise.all only waits for quiescence.
    await Promise.all(this._disposables.clear().map((dispose) => {
      return composeError(async (info) => {
        await Promise.resolve()
        info.error = new Error()
        await dispose()
      }, this._runner.getOuterStack).catch((reason) => {
        const record = getEffectRecord(dispose)
        if (record) {
          record.reportCleanupFailures(reason)
        } else {
          this.ctx.logger.error(reason)
        }
      })
    }))

    this.store = undefined
    this._updateState(() => {
      // Cleanup failures have already been contained above. Only an execution
      // failure stops a non-terminal Fiber in FAILED.
      if (this.uid === null) {
        this.inertia = undefined
      } else if (executionError !== undefined) {
        this._error = executionError
        this._runner.epoch = INACTIVE
        this.inertia = undefined
      } else if (this._runner.epoch === INACTIVE) {
        this.inertia = undefined
      } else {
        this.inertia = this._observeLifecycleTask(this._reload())
        return FiberState.LOADING
      }
    })
    if (executionError !== undefined) throw executionError
  }

  async await() {
    const fiber = this.ctx.fiber
    while (fiber.inertia) {
      await fiber.inertia
    }
    if (fiber._error) throw fiber._error
    return this
  }

  async restart() {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    fiber._setEpoch(INACTIVE)
    fiber._refresh(true)
    await fiber.await()
  }

  update(config: any, noSave = false) {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    config = resolveConfig(fiber.runtime!, config)
    return fiber.context.waterfall(fiber, 'internal/update', config, noSave, () => {
      const configError = fiber._configError
      fiber.config = config
      fiber._configError = undefined
      if (configError !== undefined && fiber._error === configError) {
        fiber._error = undefined
        fiber._updateState(() => {})
      }
      return fiber.restart()
    })
  }
}
