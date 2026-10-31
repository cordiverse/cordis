import { Awaitable, defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context.ts'
import { Plugin } from './registry.ts'
import { buildOuterStack, composeError, DisposableList, getTraceable, isConstructor, isObject, symbols } from './utils.ts'
import { Impl } from './reflect.ts'
import { StandardSchemaV1 } from '@standard-schema/spec'

declare module './context.ts' {
  export interface Context extends Pick<Fiber, 'effect'> {
    fiber: Fiber
  }
}

const kValidationError = Symbol.for('ValidationError')

export class ValidationError extends TypeError {
  name = 'ValidationError'

  constructor(public issues: readonly StandardSchemaV1.Issue[]) {
    super(`invalid config:\n` + issues.map(issue => {
      if (issue.path?.length) {
        return `  - ${issue.message} (at ${ValidationError.formatPath(issue.path)})`
      } else {
        return `  - ${issue.message}`
      }
    }).join('\n'))
  }

  static is(error: unknown): error is ValidationError {
    return !!error?.[kValidationError]
  }

  static normalizePath(path: StandardSchemaV1.Issue['path'] = []) {
    return path.map(segment => typeof segment === 'object' ? segment.key : segment)
  }

  static formatPath(path: StandardSchemaV1.Issue['path']) {
    return ValidationError.normalizePath(path).map(String).join('.')
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
  public state = FiberState.PENDING
  public readonly dispose: () => Promise<void>
  public committed: Readonly<Dict<Impl>> | undefined
  public readonly provisions = new Set<Impl>()
  public inertia: Promise<void> | undefined

  public readonly _hooks: Dict<DisposableList<Function>> = Object.create(null)
  public readonly _disposables = new DisposableList<Disposable>()

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context

  private _error: any
  private _revision = 0
  private _runner: EffectRunner<string>
  private _store: Dict<Impl> = Object.create(null)
  private _release: (() => void) | undefined
  private _remove: (() => void) | undefined

  constructor(
    public parent: Context,
    public config: any,
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

      this._runner = {
        epoch: INACTIVE,
        getOuterStack,
        execute: function (this: Fiber) {
          const { callback } = this.runtime!
          const config = this._resolve(this.config)
          if (isConstructor(callback)) {
            // eslint-disable-next-line new-cap
            const instance = new callback(this.ctx, config)
            for (const hook of instance?.[symbols.initHooks] ?? []) {
              hook()
            }
            return instance?.[symbols.init]?.()
          } else {
            return callback(this.ctx, config)
          }
        },
        collect,
      }

      this.context.emit('internal/plugin', this)

      for (const name of Object.keys(this.inject)) {
        this._checkImpl(name)
      }

      this.dispose = parent.fiber.effect(() => {
        this._remove = runtime.fibers.push(this)
        try {
          this._refresh()
        } catch (error) {
          this.ctx.logger.error(error)
          this._error = error
        }
        return async () => {
          this.uid = null
          this.context.emit('internal/plugin', this)
          const runtime = this.runtime!
          this._remove!()
          if (!runtime.fibers.length) {
            this.ctx.registry._unregister(runtime)
          }
          this._setEpoch(INACTIVE)
          // `inertia` never rejects: `_reload` and `_unload` both log their
          // own work errors. A rejection here would mean the logger itself
          // failed, so let it propagate.
          while (this.inertia) {
            await this.inertia
          }
          // `_setEpoch()` above returns early for a fiber that was not ACTIVE,
          // so the cached state is not refreshed. Re-derive it now that
          // `uid` is null; the empty callback falls through to `_getState()`.
          this._updateState(() => {})
        }
      }, 'ctx.plugin()')
    } else {
      this.uid = 0
      this.ctx = this.context = parent
      this.state = FiberState.ACTIVE
      this.committed = Object.create(null)
      this._runner = {
        epoch: '0',
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

  private _resolve(config: any) {
    return this.context.waterfall('internal/config', this, () => config)
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
          let done = false
          try {
            while (runner.epoch === oldEpoch) {
              const result = await iter.next()
              done = !!result.done
              safeCollect(result.value)
              if (done) return
            }
          } finally {
            // close the iterator so that its finally blocks run
            if (!done) await iter.return?.()
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

    const disposables: Disposable[] = []
    const dispose = () => {
      let task!: void | Promise<void>
      for (const dispose of disposables.splice(0).reverse()) {
        if (task) {
          task = task.then(dispose)
        } else {
          const result = dispose()
          if (isObject(result) && 'then' in result) {
            task = result as any
          }
        }
      }
      return task
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
    try {
      task = this._execute(runner)
    } catch (reason) {
      dispose()
      throw reason
    }

    // prevent unhandled rejection — both from `task` itself and from the
    // disposer chain if it fails to settle cleanly.
    task?.catch(dispose).catch((error) => this.ctx.logger.error(error))

    const wrapper = defineProperty(() => {
      if (!runner.epoch) return
      runner.epoch = false
      return task ? task.then(dispose) : dispose()
    }, symbols.effect, meta) as AsyncDisposable

    const disposeAsync = () => {
      if (!runner.epoch) return
      runner.epoch = false
      return dispose()
    }
    wrapper.then = async (onFulfilled, onRejected) => {
      return Promise.resolve(task)
        .then(() => disposeAsync)
        .then(onFulfilled, onRejected)
    }
    disposables.push(this._disposables.push(wrapper))
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
    for (const impl of this.provisions) {
      if (this.ctx.reflect.store[impl.isolate] !== impl) continue
      this.ctx.isolate(impl.name, impl.isolate).reflect.notify([impl.name])
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
      impl.ctx.logger.error(error)
      return delete this._store[name]
    }
    this._store[name] = impl
  }

  _replace(runtime: Plugin.Runtime, inject: Dict<any>) {
    if (runtime !== this.runtime) {
      this._remove!()
      this._remove = runtime.fibers.push(this)
      this.runtime = runtime
    }
    this.inject = inject
    this.context.emit('internal/replace', this)
    this._store = Object.create(null)
    for (const name of Object.keys(this.inject)) {
      this._checkImpl(name)
    }
    this._error = undefined
    this._revision++
    this._refresh()
  }

  _refresh() {
    let epoch = `${this._revision}`
    for (const name of Object.keys(this.inject)) {
      const impl = this._store[name]
      if (!impl) {
        epoch = INACTIVE
        break
      }
      epoch += ':' + impl.uid
    }
    this._setEpoch(epoch)
  }

  private _setEpoch(epoch: string) {
    const oldEpoch = this._runner.epoch
    if (epoch === oldEpoch) return
    // a failed fiber only recovers through update(), which clears _error
    if (this._error) return
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
    this.committed = { ...this._store }
    for (const impl of Object.values(this.committed)) {
      if (impl.ctx.fiber === this) continue
      impl.dependents.add(this)
    }
    const oldEpoch = this._runner.epoch
    try {
      await Promise.resolve()
      if (this._runner.epoch === oldEpoch) {
        await this._execute(this._runner)
      }
    } catch (reason) {
      // impl guarantees that the error is non-null (?)
      this.ctx.logger.error(reason)
      // A superseded load still needs cleanup, but cannot fail the new target.
      if (this._runner.epoch === oldEpoch) {
        this._error = reason
        this._runner.epoch = INACTIVE
      }
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
    // Dependents are notified when this fiber leaves ACTIVE, but may still
    // access its services during their own teardown, so the effects of this
    // fiber are only disposed after every dependent has unloaded.
    while ([...this.provisions].some(impl => impl.dependents.size)) {
      await new Promise<void>((resolve) => this._release = resolve)
    }
    this._release = undefined
    await Promise.all(this._disposables.clear().map(async (dispose) => {
      try {
        await composeError(async (info) => {
          await Promise.resolve()
          info.error = new Error()
          await dispose()
        }, this._runner.getOuterStack)
      } catch (reason) {
        this.ctx.logger.error(reason)
      }
    }))
    // release the providers waiting for this fiber to unload
    for (const impl of Object.values(this.committed ?? {})) {
      if (!impl.dependents.delete(this) || impl.dependents.size) continue
      impl.release?.()
      impl.ctx.fiber._release?.()
    }
    this.committed = undefined
    this._updateState(() => {
      if (this._runner.epoch === INACTIVE) {
        this.inertia = undefined
      } else {
        this.inertia = this._reload()
        return FiberState.LOADING
      }
    })
  }

  async await() {
    while (this.inertia) {
      await this.inertia
    }
    if (this._error) throw this._error
    return this
  }

  async restart() {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    fiber._revision++
    fiber._refresh()
    await fiber.await()
  }

  update(config: any, noSave = false): Awaitable<void> {
    const fiber = this.ctx.fiber
    fiber.assertActive()
    const loaded = fiber._runner.epoch !== INACTIVE
    const resolved = loaded ? fiber._resolve(config) : undefined
    if (!noSave) fiber.context.emit('internal/commit', fiber, config)
    fiber.config = config
    fiber._error = undefined
    const restart = () => fiber.restart()
    const result = loaded
      ? fiber.context.waterfall(fiber, 'internal/update', resolved, restart)
      : restart()
    // a listener may veto the restart, in which case there is nothing to await
    if (result === undefined) return
    const task = Promise.resolve(result)
    // the failure is already reported by the fiber, so mark it handled here:
    // a caller that drops the result cannot turn it into an unhandled
    // rejection, while `await update()` still observes it
    task.catch(() => {})
    return task
  }
}
