import { Awaitable, defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context.js'
import { Inject, Plugin, resolveConfig } from './registry.js'
import { buildOuterStack, composeError, DisposableList, getTraceable, isConstructor, isObject, symbols } from './utils.js'

declare module './context' {
  export interface Context {
    fiber: Fiber<this>
    effect(execute: () => SyncEffect, label?: string): Disposable<void | Promise<void>>
    effect(execute: () => AsyncEffect, label?: string): AsyncDisposable<Promise<void>>
    effect(execute: () => Effect, label?: string): AsyncDisposable<void | Promise<void>>
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

interface EffectRunner {
  isActive: boolean
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

export class Fiber<out C extends Context = Context> {
  public uid: number | null
  public ctx: C
  public config: any
  public acceptors = new DisposableList<(config: any) => boolean>()
  public state = FiberState.PENDING
  public dispose: () => Promise<void>
  public store: Dict | undefined
  public version = 0
  public inertia: Promise<void> | undefined

  public _disposables = new DisposableList<Disposable>()

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context

  private _error: any
  private _runner: EffectRunner
  private _store: Dict | undefined

  constructor(
    public parent: C,
    config: any,
    public inject: Dict<Inject.Meta | undefined>,
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
        for (const [name, inject] of injectEntries) {
          if (isNullable(inject!.config)) continue
          this.ctx[Context.intercept][name] = inject!.config
        }
      }

      this._runner = {
        isActive: false,
        getOuterStack,
        execute: () => {
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

      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.push(this)
        try {
          this.config = resolveConfig(runtime, config)
          this._setActive(true)
        } catch (error) {
          this.context.emit('internal/error', error)
          this._error = error
        }
        this.context.emit('internal/plugin', this)
        return async () => {
          this.uid = null
          this.context.emit('internal/plugin', this)
          if (this.ctx.registry.has(runtime.callback)) {
            remove()
            if (!runtime.fibers.length) {
              this.ctx.registry.delete(runtime.callback)
            }
          }
          this._setActive(false)
          await this
        }
      }, 'ctx.plugin()')
    } else {
      this.uid = 0
      this.ctx = this.context = parent
      this.state = FiberState.ACTIVE
      this._runner = {
        isActive: true,
        getOuterStack,
        execute: () => {},
        collect,
      }
      this.dispose = async () => {
        this._setActive(false)
        await this.inertia
      }
    }
  }

  assertActive() {
    if (this.uid !== null) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  private _execute(runner: EffectRunner) {
    return composeError((info) => {
      const safeCollect = (dispose: void | Disposable) => {
        if (typeof dispose === 'function') {
          runner.collect(dispose)
        } else if (!isNullable(dispose)) {
          throw new TypeError('Invalid effect')
        }
      }
      const effect: Effect = runner.execute()
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
            if (!runner.isActive) return
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
    const runner: EffectRunner = {
      execute,
      isActive: true,
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

    task &&= task.catch((reason) => {
      dispose()
      throw reason
    })

    const wrapper = defineProperty(() => {
      if (!runner.isActive) return
      runner.isActive = false
      return task ? task.then(dispose) : dispose()
    }, symbols.effect, meta) as AsyncDisposable

    const disposeAsync = () => {
      if (!runner.isActive) return
      runner.isActive = false
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
    if (this._runner.isActive) return FiberState.ACTIVE
    return FiberState.PENDING
  }

  private _updateState(callback: () => void | FiberState) {
    const oldValue = this.state
    this.state = callback() ?? this._getState()
    if (oldValue !== this.state) {
      this.context.emit('internal/status', this, oldValue)
    }
  }

  private _getStore(): Dict | undefined {
    try {
      const store = Object.create(null)
      for (const [name, inject] of Object.entries(this.inject)) {
        if (!inject!.required) continue
        const service = this.ctx.reflect.get(name, true)
        if (isNullable(service)) return
        if (service[symbols.check]) {
          const _service = getTraceable(this.ctx, service)
          if (!_service[symbols.check]()) return
        }
        store[name] = service
      }
      return this._store = store
    } catch (error) {
      this.context.emit(this.ctx, 'internal/error', error)
      this._error = error
      this._runner.isActive = false
    }
  }

  _setActive(value: boolean) {
    if (value === this._runner.isActive) return
    if (value && (!this.uid || !this._getStore())) return
    this._updateState(() => {
      const createInert = !this.inertia && value !== this._runner.isActive
      this._runner.isActive = value
      if (!createInert) return
      if (value) {
        this.inertia = this._reload()
        return FiberState.LOADING
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  private async _reload() {
    this.store = this._store
    this.version += 1
    try {
      await Promise.resolve()
      await this._execute(this._runner)
    } catch (reason) {
      // the registry impl guarantees that the error is non-null
      this.context.emit(this.ctx, 'internal/error', reason)
      this._error = reason
      this._runner.isActive = false
    }
    this._updateState(() => {
      if (this._runner.isActive) {
        this.inertia = undefined
      } else {
        this.inertia = this._unload()
        return FiberState.UNLOADING
      }
    })
  }

  private async _unload() {
    await Promise.all(this._disposables.clear().map(async (dispose) => {
      try {
        await composeError(async (info) => {
          await Promise.resolve()
          info.error = new Error()
          await dispose()
        }, this._runner.getOuterStack)
      } catch (reason) {
        this.context.emit(this.ctx, 'internal/error', reason)
      }
    }))
    this.store = undefined
    this._updateState(() => {
      if (this._runner.isActive) {
        this.inertia = this._reload()
        return FiberState.LOADING
      } else {
        this.inertia = undefined
      }
    })
  }

  private async _await() {
    while (this.inertia) {
      await this.inertia
    }
    if (this._error) throw this._error
  }

  then(onFulfilled?: () => any, onRejected?: (reason: any) => any) {
    return this._await().then(onFulfilled, onRejected)
  }

  catch(onRejected?: (reason: any) => any) {
    return this._await().catch(onRejected)
  }

  finally(onFinally?: () => any) {
    return this._await().finally(onFinally)
  }

  async restart() {
    this._setActive(false)
    this._setActive(true)
  }

  update(config: any) {
    if (this.context.bail(this, 'internal/update', this, config)) return
    try {
      this.config = resolveConfig(this.runtime!, config)
    } catch (error) {
      this.context.emit('internal/error', error)
      this._error = error
      this._setActive(false)
      return
    }
    this._error = undefined
    this.restart()
  }
}
