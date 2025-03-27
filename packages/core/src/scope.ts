import { Awaitable, defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { Inject, Plugin, resolveConfig } from './registry'
import { buildOuterStack, composeError, DisposableList, isConstructor, isObject, symbols } from './utils'

declare module './context' {
  export interface Context {
    scope: EffectScope<this>
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
  execute: () => Effect
  collect: (dispose: Disposable) => void
  getOuterStack: () => string[]
}

export const enum ScopeStatus {
  PENDING,
  LOADING,
  ACTIVE,
  FAILED,
  DISPOSED,
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

export class EffectScope<out C extends Context = Context> {
  public uid: number | null
  public ctx: C
  public config: any
  public acceptors = new DisposableList<() => boolean>()
  public disposables = new DisposableList<Disposable>()
  public status = ScopeStatus.PENDING
  public dispose: () => Promise<void>

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context

  private _error: any
  private _pending: Promise<void> | undefined
  private _runner: EffectRunner

  constructor(
    public parent: C,
    config: any,
    public inject: Dict<Inject.Meta>,
    public runtime: Plugin.Runtime | null,
    getOuterStack: () => string[],
  ) {
    this._runner = {
      isActive: false,
      getOuterStack,
      execute: () => {
        if (isConstructor(this.runtime!.callback)) {
          // eslint-disable-next-line new-cap
          const instance = new this.runtime!.callback(this.ctx, this.config)
          for (const hook of instance?.[symbols.initHooks] ?? []) {
            hook()
          }
          return instance?.[symbols.init]?.()
        } else {
          return this.runtime!.callback(this.ctx, this.config)
        }
      },
      collect: (dispose) => {
        this.disposables.push(dispose)
      },
    }

    if (parent.scope) {
      this.uid = parent.registry.counter
      this.ctx = this.context = parent.extend({ scope: this })

      const injectEntries = Object.entries(this.inject)
      if (injectEntries.length) {
        this.ctx[Context.intercept] = Object.create(parent[Context.intercept])
        for (const [name, inject] of injectEntries) {
          if (isNullable(inject.config)) continue
          this.ctx[Context.intercept][name] = inject.config
        }
      }

      this.dispose = parent.scope.effect(() => {
        const remove = runtime!.scopes.push(this)
        this.context.emit('internal/plugin', this)
        try {
          this.config = resolveConfig(runtime!, config)
          this.active = true
        } catch (error) {
          this.context.emit('internal/error', error)
          this._error = error
        }
        return async () => {
          this.uid = null
          this.context.emit('internal/plugin', this)
          if (this.ctx.registry.has(runtime!.callback)) {
            remove()
            if (!runtime!.scopes.length) {
              this.ctx.registry.delete(runtime!.callback)
            }
          }
          this.active = false
          await this._pending
        }
      }, 'ctx.plugin()')
    } else {
      this.uid = 0
      this.ctx = this.context = parent
      this._runner.isActive = true
      this.status = ScopeStatus.ACTIVE
      this.dispose = async () => {
        this.active = false
        await this._pending
      }
    }
  }

  get pending() {
    return this._pending
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
      const effect = runner.execute()
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
        this.disposables.delete(dispose)
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
    disposables.push(this.disposables.push(wrapper))
    return wrapper
  }

  getEffects() {
    return [...this.disposables]
      .map<EffectMeta>(dispose => dispose[symbols.effect])
      .filter(Boolean)
  }

  private _getStatus() {
    if (this._pending) return ScopeStatus.LOADING
    if (this.uid === null) return ScopeStatus.DISPOSED
    if (this._error) return ScopeStatus.FAILED
    if (this._runner.isActive) return ScopeStatus.ACTIVE
    return ScopeStatus.PENDING
  }

  private _updateStatus(callback: () => void) {
    const oldValue = this.status
    callback()
    this.status = this._getStatus()
    if (oldValue !== this.status) {
      this.context.emit('internal/status', this, oldValue)
    }
  }

  private async _reload() {
    try {
      await Promise.resolve()
      await this._execute(this._runner)
    } catch (reason) {
      // the registry impl guarantees that the error is non-null
      this.context.emit(this.ctx, 'internal/error', reason)
      this._error = reason
      this._runner.isActive = false
    }
    this._updateStatus(() => {
      this._pending = this._runner.isActive ? undefined : this._unload()
    })
  }

  private async _unload() {
    await Promise.all(this.disposables.clear().map(async (dispose) => {
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
    this._updateStatus(() => {
      this._pending = this._runner.isActive ? this._reload() : undefined
    })
  }

  checkInject() {
    try {
      return Object.entries(this.inject).every(([name, inject]) => {
        if (!inject.required) return true
        const service = this.ctx.reflect.get(name, true)
        if (isNullable(service)) return false
        if (!service[symbols.check]) return true
        return service[symbols.check](this.ctx)
      })
    } catch (error) {
      this.context.emit(this.ctx, 'internal/error', error)
      this._error = error
      this._runner.isActive = false
      return false
    }
  }

  get active() {
    return this._runner.isActive
  }

  set active(value) {
    if (value && (!this.uid || !this.checkInject())) return
    this._updateStatus(() => {
      if (!this._pending && value !== this._runner.isActive) {
        this._pending = value ? this._reload() : this._unload()
      }
      this._runner.isActive = value
    })
  }

  private async _await() {
    while (this.pending) {
      await this.pending
    }
    if (this._error) throw this._error
  }

  then(onFulfilled?: () => any, onRejected?: (reason: any) => any) {
    return this._await().then(onFulfilled, onRejected)
  }

  async restart() {
    this.active = false
    this.active = true
  }

  update(config: any) {
    if (this.context.bail(this, 'internal/update', this, config)) return
    try {
      this.config = resolveConfig(this.runtime!, config)
    } catch (error) {
      this.context.emit('internal/error', error)
      this._error = error
      this.active = false
      return
    }
    this._error = undefined
    this.restart()
  }
}
