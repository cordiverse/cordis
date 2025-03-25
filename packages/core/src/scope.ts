import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context'
import { Inject, Plugin, resolveConfig } from './registry'
import { composeError, DisposableList, isConstructor, symbols } from './utils'

declare module './context' {
  export interface Context {
    scope: EffectScope<this>
    effect(callback: Effect, label?: string): () => Promise<void>
  }
}

export type Disposable<T = any> = () => T

export type Effect<T = void> = () => Disposable<T> | Iterable<Disposable, void, void>

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
    private getOuterStack: () => Iterable<string>,
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

  effect<T = void>(callback: Effect<T>, label = 'anonymous'): () => T {
    this.assertActive()
    const result = callback()
    let isDisposed = false
    let dispose: Disposable
    const meta: EffectMeta = { label, children: [] }
    const update = (disposable: Disposable) => {
      this.disposables.delete(disposable)
      if (disposable[symbols.effect]) {
        meta.children.push(disposable[symbols.effect])
      }
    }
    if (typeof result === 'function') {
      update(result)
      dispose = result
    } else if (result[Symbol.iterator]) {
      const iter = result[Symbol.iterator]()
      const disposables: Disposable[] = []
      dispose = () => disposables.forEach(dispose => dispose())
      try {
        while (true) {
          const value = iter.next()
          if (value.value) {
            update(value.value)
            disposables.unshift(value.value)
          }
          if (value.done) break
        }
      } catch (error) {
        dispose()
        throw error
      }
    } else {
      throw new TypeError('effect must return a function or an iterable')
    }
    const wrapped = defineProperty((...args: []) => {
      // make sure the original callback is not called twice
      if (isDisposed) return
      isDisposed = true
      remove()
      return dispose(...args)
    }, symbols.effect, meta)
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
      await composeError(async () => {
        let result: any, label: string
        if (isConstructor(this.runtime!.callback)) {
          // eslint-disable-next-line new-cap
          const instance = new this.runtime!.callback(this.ctx, this.config)
          for (const hook of instance?.[symbols.initHooks] ?? []) {
            hook()
          }
          result = await instance?.[symbols.init]?.()
          label = `${this.runtime!.callback.name}[Symbol(cordis.init)]()`
        } else {
          result = await this.runtime!.callback(this.ctx, this.config)
          label = `${this.runtime!.callback.name}()`
        }
        if (typeof result === 'function') {
          defineProperty(result, symbols.effect, { label, children: [] })
          this.disposables.push(result)
        } else if (result?.[Symbol.iterator] || result?.[Symbol.asyncIterator]) {
          for await (const dispose of result) {
            this.disposables.push(dispose)
          }
        }
      }, 2, this.getOuterStack)
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
        await composeError(dispose, 1, this.getOuterStack)
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

  then(onFulfilled: () => any, onRejected?: (reason: any) => any) {
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
