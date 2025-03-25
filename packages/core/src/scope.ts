import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { Inject, Plugin, resolveConfig } from './registry'
import { composeError, DisposableList, isConstructor, isObject, symbols } from './utils'

declare module './context' {
  export interface Context {
    scope: EffectScope<this>
    effect(factory: () => Effect, label?: string): AsyncDispose
  }
}

export interface AsyncDispose extends PromiseLike<() => Promise<void>> {
  (): Promise<void>
}

type Disposable = () => any

export type Effect =
  | Disposable
  | Promise<Disposable>
  | Iterable<Disposable, void, void>
  | AsyncIterable<Disposable, void, void>

export interface EffectMeta {
  label: string
  children: EffectMeta[]
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

  private _active = false
  private _error: any
  private _pending: Promise<void> | undefined

  constructor(
    public parent: C,
    config: any,
    public inject: Dict<Inject.Meta>,
    public runtime: Plugin.Runtime | null,
    private getOuterStack: () => string[],
  ) {
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
      this._active = true
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

  private _collect(factory: () => Effect, collect: (dispose: Disposable) => void) {
    const safeCollect = (dispose: void | Disposable) => {
      if (typeof dispose === 'function') {
        collect(dispose)
      } else if (!isNullable(dispose)) {
        throw new TypeError('Invalid effect')
      }
    }
    const effect = factory()
    if (typeof effect === 'function') {
      return collect(effect)
    } else if (isNullable(effect)) {
      // return
    } else if (!isObject(effect)) {
      throw new TypeError('Invalid effect')
    } else if ('then' in effect) {
      return effect.then(safeCollect)
    } else if (Symbol.iterator in effect) {
      const iter = effect[Symbol.iterator]()
      while (true) {
        const result = iter.next()
        safeCollect(result.value)
        if (result.done) return
      }
    } else if (Symbol.asyncIterator in effect) {
      const iter = effect[Symbol.asyncIterator]()
      return (async () => {
        while (true) {
          const result = await iter.next()
          safeCollect(result.value)
          if (result.done) return
        }
      })()
    } else {
      throw new TypeError('Invalid effect')
    }
  }

  effect(factory: () => Effect, label = 'anonymous'): AsyncDispose {
    this.assertActive()
    let isDisposed = false
    const meta: EffectMeta = { label, children: [] }
    const disposables: Disposable[] = []
    let task = this._collect(factory, (dispose) => {
      disposables.push(dispose)
      this.disposables.delete(dispose)
      if (dispose[symbols.effect]) {
        meta.children.push(dispose[symbols.effect])
      }
    })
    const wrapped = defineProperty(() => {
      // make sure the original callback is not called twice
      if (isDisposed) return
      isDisposed = true
      remove()
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
    }, symbols.effect, meta) as AsyncDispose
    const remove = this.disposables.push(wrapped)
    return wrapped
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
    if (this._active) return ScopeStatus.ACTIVE
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
      await composeError(async (info) => {
        info.offset += 1
        await this._collect(() => {
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
        }, (dispose) => {
          this.disposables.push(dispose)
        })
      }, this.getOuterStack)
    } catch (reason) {
      // the registry impl guarantees that the error is non-null
      this.context.emit(this.ctx, 'internal/error', reason)
      this._error = reason
      this._active = false
    }
    this._updateStatus(() => {
      this._pending = this._active ? undefined : this._unload()
    })
  }

  private async _unload() {
    await Promise.all(this.disposables.clear().map(async (dispose) => {
      try {
        await composeError(dispose, this.getOuterStack)
      } catch (reason) {
        this.context.emit(this.ctx, 'internal/error', reason)
      }
    }))
    this._updateStatus(() => {
      this._pending = this._active ? this._reload() : undefined
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
      this._active = false
      return false
    }
  }

  get active() {
    return this._active
  }

  set active(value) {
    if (value && (!this.uid || !this.checkInject())) return
    this._updateStatus(() => {
      if (!this._pending && value !== this._active) {
        this._pending = value ? this._reload() : this._unload()
      }
      this._active = value
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
