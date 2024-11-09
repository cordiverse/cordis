import { isNullable } from 'cosmokit'
import { Context } from './context'
import { Plugin } from './registry'
import { DisposableList } from './utils'

declare module './context' {
  export interface Context {
    scope: EffectScope<this>
    effect(callback: Effect): () => boolean
  }
}

export type Disposable = () => void

export type Effect = () => Disposable | Generator<Disposable, void, void>

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
  public isActive = false
  public dispose: () => void

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context
  protected tasks = new Set<Promise<void>>()
  protected hasError = false

  constructor(public parent: C, public config: C['config'], private apply: (ctx: C, config: any) => any, public runtime?: Plugin.Runtime) {
    if (parent.scope) {
      this.uid = parent.registry.counter
      this.ctx = this.context = parent.extend({ scope: this })
      this.dispose = parent.scope.effect(() => {
        const remove = this.runtime?.scopes.push(this)
        return () => {
          this.uid = null
          this.reset()
          this.context.emit('internal/plugin', this)
          if (!this.runtime) return
          remove?.()
          if (this.runtime.scopes.length) return
          this.ctx.registry.delete(this.runtime.plugin)
        }
      })
      this.context.emit('internal/plugin', this)
    } else {
      this.uid = 0
      this.ctx = this.context = parent
      this.isActive = true
      this.status = ScopeStatus.ACTIVE
      this.dispose = () => {
        throw new Error('cannot dispose root scope')
      }
    }
  }

  assertActive() {
    if (this.isActive) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  effect(callback: Effect): () => boolean {
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
      if (isDisposed) return false
      isDisposed = true
      remove()
      dispose(...args)
      return true
    }
    const remove = this.disposables.push(wrapped)
    return wrapped
  }

  async restart() {
    await this.reset()
    this.hasError = false
    this.status = ScopeStatus.PENDING
    await this.start()
  }

  protected _getStatus() {
    if (this.uid === null) return ScopeStatus.DISPOSED
    if (this.hasError) return ScopeStatus.FAILED
    if (this.isReady) return ScopeStatus.ACTIVE
    return ScopeStatus.PENDING
  }

  updateStatus(callback?: () => void) {
    const oldValue = this.status
    callback?.()
    this.status = this._getStatus()
    if (oldValue !== this.status) {
      this.context.emit('internal/status', this, oldValue)
    }
  }

  cancel() {
    this.updateStatus(() => this.hasError = true)
    this.reset()
  }

  get isReady() {
    if (!this.runtime) return true
    return Object.entries(this.runtime.inject).every(([name, inject]) => {
      return !inject.required || !isNullable(this.ctx.reflect.get(name, true))
    })
  }

  leak(disposable: Disposable) {
    this.disposables.leak(disposable)
  }

  async reset() {
    this.isActive = false
    this.disposables.popAll().forEach((dispose) => {
      (async () => dispose())().catch((reason) => {
        this.context.emit(this.ctx, 'internal/error', reason)
      })
    })
  }

  async start() {
    if (!this.isReady || this.isActive || this.uid === null) return true
    this.isActive = true
    await this.apply(this.ctx, this.config)
    this.updateStatus()
  }

  update(config: any) {
    if (this.context.bail(this, 'internal/update', this, config)) return
    this.config = config
    this.restart()
  }
}
