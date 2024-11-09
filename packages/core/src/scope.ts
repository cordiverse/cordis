import { isNullable } from 'cosmokit'
import { Context } from './context'
import { Plugin } from './registry'
import { DisposableList } from './utils'

declare module './context' {
  export interface Context {
    scope: EffectScope<this>
    effect(callback: Effect): () => Promise<void>
  }
}

export type Disposable<T = any> = () => T

export type Effect<T = void> = () => Disposable<T> | Generator<Disposable, void, void>

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

export class EffectScope<C extends Context = Context> {
  public uid: number | null
  public ctx: C
  public acceptors = new DisposableList<() => boolean>()
  public disposables = new DisposableList<Disposable>()
  public status = ScopeStatus.PENDING
  public dispose: () => Promise<void>

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context

  private _active = false
  private _error: any
  private _pending: Promise<void> | undefined

  constructor(public parent: C, public config: C['config'], private apply: (ctx: C, config: any) => any, public runtime?: Plugin.Runtime) {
    if (parent.scope) {
      this.uid = parent.registry.counter
      this.ctx = this.context = parent.extend({ scope: this })
      this.dispose = parent.scope.effect(() => {
        const remove = this.runtime?.scopes.push(this)
        this.context.emit('internal/plugin', this)
        this.setActive(true)
        return async () => {
          remove?.()
          this.uid = null
          this.context.emit('internal/plugin', this)
          if (this.runtime && !this.runtime.scopes.length) {
            this.ctx.registry.delete(this.runtime.plugin)
          }
          this.setActive(false)
          await this._pending
        }
      })
    } else {
      this.uid = 0
      this.ctx = this.context = parent
      this._active = true
      this.status = ScopeStatus.ACTIVE
      this.dispose = () => {
        throw new Error('cannot dispose root scope')
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

  effect<T = void>(callback: Effect<T>): () => T {
    this.assertActive()
    const result = callback()
    let isDisposed = false
    let dispose: Disposable
    if (typeof result === 'function') {
      dispose = result
    } else {
      const disposables: Disposable[] = []
      try {
        while (true) {
          const value = result.next()
          if (value.value) disposables.unshift(value.value)
          if (value.done) break
        }
      } catch (error) {
        disposables.forEach(dispose => dispose())
        throw error
      }
      dispose = () => disposables.forEach(dispose => dispose())
    }
    const wrapped = (...args: []) => {
      // make sure the original callback is not called twice
      if (isDisposed) return
      isDisposed = true
      remove()
      return dispose(...args)
    }
    const remove = this.disposables.push(wrapped)
    return wrapped
  }

  leak(disposable: Disposable) {
    this.disposables.leak(disposable)
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

  private _checkInject() {
    if (!this.runtime) return true
    return Object.entries(this.runtime.inject).every(([name, inject]) => {
      return !inject.required || !isNullable(this.ctx.reflect.get(name, true))
    })
  }

  private async _reload() {
    try {
      await this.apply(this.ctx, this.config)
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
    await Promise.all(this.disposables.popAll().map(async (dispose) => {
      try {
        await dispose()
      } catch (reason) {
        this.context.emit(this.ctx, 'internal/error', reason)
      }
    }))
    this._updateStatus(() => {
      this._pending = this._active ? this._reload() : undefined
    })
  }

  setActive(value: boolean) {
    if (value && (!this.uid || !this._checkInject())) return
    this._updateStatus(() => {
      if (!this._pending && value !== this._active) {
        this._pending = value ? this._reload() : this._unload()
      }
      this._active = value
    })
  }

  async wait() {
    while (this.pending) {
      await this.pending
    }
    if (this._error) throw this._error
  }

  async restart() {
    this.setActive(false)
    this.setActive(true)
  }

  update(config: any) {
    if (this.context.bail(this, 'internal/update', this, config)) return
    this.config = config
    this._error = undefined
    this.restart()
  }
}
