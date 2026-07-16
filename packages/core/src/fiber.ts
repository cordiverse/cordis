import { Awaitable, defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { Plugin } from './registry'
import { buildOuterStack, composeError, DisposableList, getTraceable, isConstructor, isObject, symbols } from './utils'
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

// Public effect disposers remain single-shot, but structural owners and outer
// effects must still be able to join a cleanup that another caller started.
const effectInertia = new WeakMap<Disposable, () => void | Promise<void>>()

interface CheckedDisposalAudit {
  errors: unknown[]
  task: Promise<void>
}

interface ActiveUnloadDiagnostics {
  errors: unknown[]
}

// Ordinary Cordis disposal deliberately contains effect failures. A terminal
// root owner can opt into one checked audit without changing HMR/plugin
// semantics; nested fibers find the same root-keyed collector while unloading.
const checkedDisposalAudits = new WeakMap<Context, CheckedDisposalAudit>()
const activeUnloadDiagnostics = new WeakMap<Context, Set<ActiveUnloadDiagnostics>>()

function recordCheckedDisposalError(ctx: Context, error: unknown): void {
  checkedDisposalAudits.get(ctx.root)?.errors.push(error)
}

function runDisposable(dispose: Disposable) {
  const result = dispose()
  return effectInertia.get(dispose)?.() ?? result
}

/** Notify plugin teardown without allowing one observer to break ownership cleanup. */
function emitPluginDisposed(context: Context, fiber: Fiber) {
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
      const returned = callback(...args)
      Promise.resolve(returned).catch(error => context.logger.error(error))
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

const INACTIVE = '__INACTIVE__'

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
  private _runner: EffectRunner<string>
  private _store: Dict<Impl> = Object.create(null)

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
      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this)
        try {
          this.config = resolveConfig(runtime, config)
          shouldRefresh = true
        } catch (error) {
          this.ctx.logger.error(error)
          this._error = error
        }
        return async () => {
          this.uid = null
          emitPluginDisposed(this.context, this)
          if (this.ctx.registry.has(runtime.callback)) {
            remove()
            if (!runtime.fibers.length) {
              this.ctx.registry.delete(runtime.callback)
            }
          }
          this._setEpoch(INACTIVE)
          // A PENDING fiber can already own effects registered by an
          // internal/plugin observer. Its epoch is still INACTIVE, so
          // _setEpoch() has no transition to drive; explicitly unload that
          // pre-activation work before reporting disposal complete.
          if (!this.inertia) {
            this._updateState(() => {
              this.inertia = this._unload()
              return FiberState.UNLOADING
            })
          }
          // `this.inertia` itself should never reject — both `_reload` and
          // `_unload` swallow their own work errors via `ctx.logger.error`.
          // If it *does* reject, the only remaining cause is the logger
          // itself failing, which we can't recover from in this exact spot
          // (calling the logger again is what just failed). Let the
          // rejection propagate; process-level crash is the honest outcome.
          while (this.inertia) {
            await this.inertia
          }
        }
      }, 'ctx.plugin()')

      try {
        // Publish only after the parent owns a fully assigned disposer. A
        // synchronous observer may dispose either this fiber or its parent.
        this.context.emit('internal/plugin', this)
      } catch (error) {
        // Publication failed synchronously. The disposer removes the child
        // from both the parent and runtime before control escapes.
        Promise.resolve(this.dispose()).catch(reason => this.ctx.logger.error(reason))
        throw error
      }

      // Keep the initial notification's historical PENDING view. The loader
      // may also extend `inject` in that notification, so resolve dependencies
      // only after publication. A reentrant parent unload makes the child
      // disposer responsible for draining any PENDING effects instead.
      if (this.uid !== null && parent.fiber.state !== FiberState.UNLOADING) {
        for (const name of Object.keys(this.inject)) {
          this._checkImpl(name)
        }
        if (shouldRefresh) this._refresh()
      }
    } else {
      this.uid = 0
      this.ctx = this.context = parent
      this.state = FiberState.ACTIVE
      this.store = Object.create(null)
      this._runner = {
        epoch: '',
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

  /**
   * Dispose the root tree to quiescence and reject after every contained
   * effect-cleanup failure has been observed. Ordinary {@link dispose} keeps
   * Cordis's failure-containing HMR semantics; process-level terminal owners
   * use this checked form when cleanup outcome controls exit semantics.
   * Concurrent checked calls join one audit and one root disposal.
   *
   * @returns a task that rejects with an `AggregateError` after disposal when
   * any nested cleanup failed.
   * @throws when invoked on a non-root fiber.
   */
  disposeChecked(): Promise<void> {
    const root = this.context.root
    if (root.fiber !== this) {
      throw new TypeError('disposeChecked() is only supported on the root fiber')
    }
    const active = checkedDisposalAudits.get(root)
    if (active) return active.task

    // Publish a concrete join task before disposal can synchronously emit a
    // lifecycle event. A reentrant checked caller must never observe a
    // half-initialized audit, and terminal disposal must close effect admission
    // before this method returns to its caller.
    const completion = Promise.withResolvers<void>()
    const audit: CheckedDisposalAudit = { errors: [], task: completion.promise }
    audit.task = completion.promise.finally(() => {
      if (checkedDisposalAudits.get(root) === audit) checkedDisposalAudits.delete(root)
    })
    checkedDisposalAudits.set(root, audit)
    for (const diagnostics of activeUnloadDiagnostics.get(root) ?? []) {
      audit.errors.push(...diagnostics.errors)
    }

    let disposal: Promise<void>
    try {
      disposal = this.dispose()
    } catch (error: unknown) {
      audit.errors.push(error)
      disposal = Promise.resolve()
    }
    disposal
      .catch((error: unknown) => { audit.errors.push(error) })
      .then(() => {
        if (audit.errors.length > 0) {
          throw new AggregateError(audit.errors, 'Cordis root disposal failed')
        }
      })
      .then(
        () => completion.resolve(undefined),
        (error: unknown) => completion.reject(error),
      )
    return audit.task
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
    this.assertActive()
    if (this.state === FiberState.UNLOADING) {
      throw new CordisError('INACTIVE_EFFECT')
    }

    const disposables: Disposable[] = []
    let disposing = false
    let disposalTask: void | Promise<void>
    const dispose = () => {
      if (disposing) return disposalTask
      disposing = true
      const errors: unknown[] = []
      const runOne = (disposable: Disposable): void | Promise<void> => {
        try {
          const result = runDisposable(disposable)
          if (isObject(result) && 'then' in result) {
            return Promise.resolve(result as PromiseLike<void>)
              .catch((error: unknown) => { errors.push(error) })
          }
        } catch (error: unknown) {
          errors.push(error)
        }
      }
      const finish = (): void => {
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Cordis composite effect disposal failed')
        }
      }
      let task: Promise<void> | undefined
      for (const disposable of disposables.splice(0).reverse()) {
        if (task === undefined) {
          const result = runOne(disposable)
          if (result !== undefined) task = result
        } else {
          task = task.then(() => runOne(disposable))
        }
      }
      if (task === undefined) return finish()
      return disposalTask = task.then(finish)
    }

    const meta: EffectMeta = { label, children: [] }
    const runner: EffectRunner<boolean> = {
      execute,
      epoch: true,
      collect: (dispose) => {
        disposables.push(dispose)
        this._disposables.delete(dispose)
        if (dispose[symbols.effect]) {
          meta.children.push(dispose[symbols.effect])
        }
      },
      getOuterStack: buildOuterStack(),
    }

    let task: void | Promise<void>
    let executing = true
    let resolveSetup: (() => void) | undefined
    let rejectSetup: ((reason: unknown) => void) | undefined
    let setupBarrier: Promise<void> | undefined
    let setupFailed = false
    let inFlight: void | Promise<void>
    let removeWrapper = () => false

    const waitForSetup = () => {
      setupBarrier ??= new Promise<void>((resolve, reject) => {
        resolveSetup = resolve
        rejectSetup = reject
      })
      return setupBarrier
    }

    const disposeAfter = (setup: PromiseLike<void>) => {
      return Promise.resolve(setup).then(
        () => dispose(),
        async (reason) => {
          await dispose()
          throw reason
        },
      )
    }

    const finalizeDisposal = (callback: () => void | Promise<void>) => {
      let result: void | Promise<void>
      try {
        result = callback()
      } catch (error) {
        removeWrapper()
        throw error
      }
      if (isObject(result) && 'then' in result) {
        const pending = Promise.resolve(result).finally(() => {
          removeWrapper()
          if (inFlight === pending) inFlight = undefined
        })
        return inFlight = pending
      }
      removeWrapper()
      return result
    }

    const wrapper = defineProperty(() => {
      // A synchronous setup failure can race an owner unload that already
      // captured this wrapper but has not invoked it yet. The failed effect is
      // never returned publicly, so let that internal caller await rollback.
      if (!runner.epoch) return setupFailed ? inFlight : undefined
      runner.epoch = false
      return finalizeDisposal(() => {
        if (executing) return disposeAfter(waitForSetup())
        return task ? disposeAfter(task) : dispose()
      })
    }, symbols.effect, meta) as AsyncDisposable
    effectInertia.set(wrapper, () => inFlight)

    // Make the effect visible to a reentrant owner unload before execute()
    // runs any plugin code. Async teardown stays owner-visible until it
    // settles, allowing an outer effect to join cleanup another caller began.
    removeWrapper = this._disposables.push(wrapper)
    try {
      task = this._execute(runner)
    } catch (reason) {
      executing = false
      setupFailed = true
      runner.epoch = false
      let cleanup: void | Promise<void>
      try {
        cleanup = finalizeDisposal(dispose)
      } finally {
        rejectSetup?.(reason)
      }
      if (isObject(cleanup) && 'then' in cleanup) {
        cleanup.catch(error => this.ctx.logger.error(error))
      }
      throw reason
    }
    executing = false
    if (setupBarrier) {
      Promise.resolve(task).then(resolveSetup, rejectSetup)
    }

    // prevent unhandled rejection — both from `task` itself and from the
    // disposer chain if it fails to settle cleanly.
    task?.catch(() => {
      if (!runner.epoch) return dispose()
      return finalizeDisposal(dispose)
    }).catch((error) => this.ctx.logger.error(error))

    const disposeAsync = () => {
      if (!runner.epoch) return
      runner.epoch = false
      return finalizeDisposal(dispose)
    }
    wrapper.then = async (onFulfilled, onRejected) => {
      return Promise.resolve(task)
        .then(() => disposeAsync)
        .then(onFulfilled, onRejected)
    }
    return wrapper
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

  _refresh() {
    let epoch: string | boolean = false
    epoch = ''
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) {
        epoch = INACTIVE
        break
      }
      epoch += ':' + impl.fiber.uid
    }
    this._setEpoch(epoch)
  }

  private _setEpoch(epoch: string) {
    const oldEpoch = this._runner.epoch
    if (epoch === oldEpoch) return
    this._runner.epoch = epoch
    if (this.inertia) return
    this._updateState(() => {
      if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
        this.inertia = this._reload()
        return FiberState.LOADING
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  private async _reload() {
    this.store = { ...this._store }
    const oldEpoch = this._runner.epoch
    try {
      await Promise.resolve()
      // A disposer queued before this checkpoint may already have invalidated
      // the load. Do not run plugin code for a stale epoch; the state update
      // below will drain any effects collected while the fiber was PENDING.
      if (this._runner.epoch === oldEpoch) {
        await this._execute(this._runner)
      }
    } catch (reason) {
      // impl guarantees that the error is non-null (?)
      this.ctx.logger.error(reason)
      this._error = reason
      this._runner.epoch = INACTIVE
    }
    this._updateState(() => {
      if (this._runner.epoch === oldEpoch) {
        this.inertia = undefined
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  private async _unload() {
    const root = this.context.root
    const diagnostics: ActiveUnloadDiagnostics = { errors: [] }
    let active = activeUnloadDiagnostics.get(root)
    if (active === undefined) {
      active = new Set()
      activeUnloadDiagnostics.set(root, active)
    }
    active.add(diagnostics)
    try {
      await Promise.all(this._disposables.clear().map(async (dispose) => {
        try {
          await composeError(async (info) => {
            await Promise.resolve()
            info.error = new Error()
            await runDisposable(dispose)
          }, this._runner.getOuterStack)
        } catch (reason) {
          diagnostics.errors.push(reason)
          recordCheckedDisposalError(this.context, reason)
          this.ctx.logger.error(reason)
        }
      }))
      this.store = undefined
      this._updateState(() => {
        if (this._runner.epoch === INACTIVE) {
          this.inertia = undefined
        } else {
          this.inertia = this._reload()
          return FiberState.LOADING
        }
      })
    } finally {
      active.delete(diagnostics)
      if (active.size === 0) activeUnloadDiagnostics.delete(root)
    }
  }

  async await() {
    while (this.inertia) {
      await this.inertia
    }
    if (this._error) throw this._error
    return this
  }

  async restart() {
    this.assertActive()
    this._setEpoch(INACTIVE)
    this._refresh()
    await this.await()
  }

  update(config: any, noSave = false) {
    this.assertActive()
    config = resolveConfig(this.runtime!, config)
    this.context.waterfall(this, 'internal/update', config, noSave, () => {
      this.config = config
      this._error = undefined
      return this.restart()
    })
  }
}
