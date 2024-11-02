import { deepEqual, defineProperty, isNullable, remove } from 'cosmokit'
import { Context } from './context.ts'
import { Plugin } from './registry.ts'
import { isConstructor, resolveConfig } from './utils.ts'

declare module './context.ts' {
  export interface Context {
    scope: EffectScope<this>
    effect<T extends DisposableLike>(callback: Callable<T, [ctx: this]>): T
    effect<T extends DisposableLike, R>(callback: Callable<T, [ctx: this, config: R]>, config: R): T
    /** @deprecated use `ctx.effect()` instead */
    collect(label: string, callback: () => void): () => void
    accept(callback?: (config: this['config']) => void | boolean, options?: AcceptOptions): () => boolean
    accept(keys: (keyof this['config'])[], callback?: (config: this['config']) => void | boolean, options?: AcceptOptions): () => boolean
    decline(keys: (keyof this['config'])[]): () => boolean
  }
}

export type Disposable = () => void

export type DisposableLike = Disposable | { dispose: Disposable }

export type Callable<T, R extends unknown[]> = ((...args: R) => T) | (new (...args: R) => T)

export interface AcceptOptions {
  passive?: boolean
  immediate?: boolean
}

export interface Acceptor extends AcceptOptions {
  keys?: string[]
  callback?: (config: any) => void | boolean
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

export class EffectScope<C extends Context = Context> {
  public uid: number | null
  public ctx: C
  public disposables: Disposable[] = []
  public error: any
  public status = ScopeStatus.PENDING
  public isActive = false
  public dispose: () => void

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context
  protected proxy: any
  protected acceptors: Acceptor[] = []
  protected tasks = new Set<Promise<void>>()
  protected hasError = false

  constructor(public parent: C, public config: C['config'], private apply: (ctx: C, config: any) => any, public meta?: Plugin.Meta) {
    if (parent.scope) {
      this.uid = parent.registry.counter
      this.ctx = this.context = parent.extend({ scope: this })
      this.dispose = parent.scope.effect(() => {
        this.meta?.scopes.push(this)
        return () => {
          this.uid = null
          this.reset()
          this.context.emit('internal/plugin', this)
          remove(this.meta?.scopes!, this)
          // TODO
          // const result = remove(runtime.disposables, this.dispose)
          // if (remove(runtime.children, this) && !runtime.children.length) {
          //   parent.registry.delete(runtime.plugin)
          // }
        }
      })
      this.proxy = new Proxy({}, {
        get: (target, key, receiver) => Reflect.get(this.config, key, receiver),
        ownKeys: (target) => Reflect.ownKeys(this.config),
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

  protected get _config() {
    return this.meta?.isReactive ? this.proxy : this.config
  }

  assertActive() {
    if (this.isActive) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  effect<D extends DisposableLike>(callback: Callable<D, [ctx: C, config: any]>, config?: any): D {
    this.assertActive()
    const result = isConstructor(callback)
      // eslint-disable-next-line new-cap
      ? new callback(this.ctx, config)
      : callback(this.ctx, config)
    let disposed = false
    const original: Disposable = typeof result === 'function'
      ? result
      : result.dispose.bind(result)
    const wrapped = (...args: []) => {
      // make sure the original callback is not called twice
      if (disposed) return
      disposed = true
      remove(this.disposables, wrapped)
      return original(...args)
    }
    this.disposables.push(wrapped)
    if (typeof result === 'function') return wrapped as D
    result.dispose = wrapped
    return result
  }

  collect(label: string, callback: () => any) {
    const dispose = defineProperty(() => {
      remove(this.disposables, dispose)
      return callback()
    }, 'name', label)
    this.disposables.push(dispose)
    return dispose
  }

  async restart() {
    await this.reset()
    this.error = null
    this.hasError = false
    this.status = ScopeStatus.PENDING
    await this.start()
  }

  protected _getStatus() {
    if (this.uid === null) return ScopeStatus.DISPOSED
    if (this.hasError) return ScopeStatus.FAILED
    if (this.tasks.size) return ScopeStatus.LOADING
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

  cancel(reason?: any) {
    this.error = reason
    this.updateStatus(() => this.hasError = true)
    this.reset()
  }

  get isReady() {
    if (!this.meta) return true
    return Object.entries(this.meta.inject).every(([name, inject]) => {
      return !inject.required || !isNullable(this.ctx.reflect.get(name, true))
    })
  }

  leak(disposable: Disposable) {
    if (remove(this.disposables, disposable)) return
    throw new Error('unexpected disposable leak')
  }

  async reset() {
    this.isActive = false
    this.disposables.splice(0).forEach((dispose) => {
      ;(async () => dispose())().catch((reason) => {
        this.context.emit(this.ctx, 'internal/error', reason)
      })
    })
  }

  async start() {
    if (!this.isReady || this.isActive || this.uid === null) return true
    this.isActive = true
    await this.apply(this.ctx, this._config)
    this.updateStatus()
  }

  accept(callback?: (config: C['config']) => void | boolean, options?: AcceptOptions): () => boolean
  accept(keys: string[], callback?: (config: C['config']) => void | boolean, options?: AcceptOptions): () => boolean
  accept(...args: any[]) {
    const keys = Array.isArray(args[0]) ? args.shift() : null
    const acceptor: Acceptor = { keys, callback: args[0], ...args[1] }
    return this.effect(() => {
      this.acceptors.push(acceptor)
      if (acceptor.immediate) acceptor.callback?.(this.config)
      return () => remove(this.acceptors, acceptor)
    })
  }

  decline(keys: string[]) {
    return this.accept(keys, () => true)
  }

  checkUpdate(resolved: any, forced?: boolean) {
    if (forced || !this.config) return [true, true]
    if (forced === false) return [false, false]

    const modified: Record<string, boolean> = Object.create(null)
    const checkPropertyUpdate = (key: string) => {
      const result = modified[key] ??= !deepEqual(this.config[key], resolved[key])
      hasUpdate ||= result
      return result
    }

    const ignored = new Set<string>()
    let hasUpdate = false, shouldRestart = false
    let fallback: boolean | null = this.meta?.isReactive || null
    for (const { keys, callback, passive } of this.acceptors) {
      if (!keys) {
        fallback ||= !passive
      } else if (passive) {
        keys?.forEach(key => ignored.add(key))
      } else {
        let hasUpdate = false
        for (const key of keys) {
          hasUpdate ||= checkPropertyUpdate(key)
        }
        if (!hasUpdate) continue
      }
      const result = callback?.(resolved)
      if (result) shouldRestart = true
    }

    for (const key in { ...this.config, ...resolved }) {
      if (fallback === false) continue
      if (!(key in modified) && !ignored.has(key)) {
        const hasUpdate = checkPropertyUpdate(key)
        if (fallback === null) shouldRestart ||= hasUpdate
      }
    }
    return [hasUpdate, shouldRestart]
  }

  update(config: any, forced?: boolean) {
    const oldConfig = this.config
    let resolved: any
    try {
      resolved = resolveConfig(this.meta?.plugin, config)
    } catch (error) {
      this.context.emit('internal/error', error)
      return this.cancel(error)
    }
    const [hasUpdate, shouldRestart] = this.checkUpdate(resolved, forced)
    this.context.emit('internal/before-update', this, config)
    this.config = resolved
    if (hasUpdate) {
      this.context.emit('internal/update', this, oldConfig)
    }
    if (shouldRestart) this.restart()
  }
}
