import { deepEqual, defineProperty, Dict, isNullable, remove } from 'cosmokit'
import { Context } from './context.ts'
import { Inject, Plugin } from './registry.ts'
import { isConstructor, resolveConfig } from './utils.ts'

declare module './context.ts' {
  export interface Context {
    scope: EffectScope<this>
    runtime: MainScope<this>
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

export abstract class EffectScope<C extends Context = Context> {
  public uid: number | null
  public ctx: C
  public disposables: Disposable[] = []
  public error: any
  public status = ScopeStatus.PENDING
  public isActive = false

  // Same as `this.ctx`, but with a more specific type.
  protected context: Context
  protected proxy: any
  protected acceptors: Acceptor[] = []
  protected tasks = new Set<Promise<void>>()
  protected hasError = false

  abstract runtime: MainScope<C>
  abstract dispose(): boolean
  abstract update(config: C['config'], forced?: boolean): void

  constructor(public parent: C, public config: C['config']) {
    this.uid = parent.registry ? parent.registry.counter : 0
    this.ctx = this.context = parent.extend({ scope: this })
    this.proxy = new Proxy({}, {
      get: (target, key) => Reflect.get(this.config, key),
    })
  }

  protected get _config() {
    return this.runtime.isReactive ? this.proxy : this.config
  }

  assertActive() {
    if (this.uid !== null || this.isActive) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  effect(callback: Callable<DisposableLike, [ctx: C, config: any]>, config?: any) {
    this.assertActive()
    const result = isConstructor(callback)
      // eslint-disable-next-line new-cap
      ? new callback(this.ctx, config)
      : callback(this.ctx, config)
    let disposed = false
    const original = typeof result === 'function' ? result : result.dispose.bind(result)
    const wrapped = (...args: []) => {
      // make sure the original callback is not called twice
      if (disposed) return
      disposed = true
      remove(this.disposables, wrapped)
      return original(...args)
    }
    this.disposables.push(wrapped)
    if (typeof result === 'function') return wrapped
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

  restart() {
    this.reset()
    this.error = null
    this.hasError = false
    this.status = ScopeStatus.PENDING
    this.start()
  }

  protected _getStatus() {
    if (this.uid === null) return ScopeStatus.DISPOSED
    if (this.hasError) return ScopeStatus.FAILED
    if (this.tasks.size) return ScopeStatus.LOADING
    if (this.ready) return ScopeStatus.ACTIVE
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

  ensure(callback: () => Promise<void>) {
    const task = callback()
      .catch((reason) => {
        this.context.emit(this.ctx, 'internal/error', reason)
        this.cancel(reason)
      })
      .finally(() => {
        this.updateStatus(() => this.tasks.delete(task))
        this.context.events._tasks.delete(task)
      })
    this.updateStatus(() => this.tasks.add(task))
    this.context.events._tasks.add(task)
  }

  cancel(reason?: any) {
    this.error = reason
    this.updateStatus(() => this.hasError = true)
    this.reset()
  }

  get ready() {
    return Object.entries(this.runtime.inject).every(([name, inject]) => {
      return !inject.required || !isNullable(this.ctx.get(name))
    })
  }

  reset() {
    this.isActive = false
    this.disposables = this.disposables.splice(0).filter((dispose) => {
      if (this.uid !== null && dispose[Context.static] === this) return true
      ;(async () => dispose())().catch((reason) => {
        this.context.emit(this.ctx, 'internal/error', reason)
      })
    })
  }

  protected init(error?: any) {
    if (!this.config) {
      this.cancel(error)
    } else {
      this.start()
    }
  }

  start() {
    if (!this.ready || this.isActive || this.uid === null) return true
    this.isActive = true
    this.updateStatus(() => this.hasError = false)
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
    let fallback: boolean | null = this.runtime.isReactive || null
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
}

export class ForkScope<C extends Context = Context> extends EffectScope<C> {
  dispose: () => boolean

  constructor(parent: Context, public runtime: MainScope<C>, config: C['config'], error?: any) {
    super(parent as C, config)

    this.dispose = defineProperty(parent.scope.collect(`fork <${parent.runtime.name}>`, () => {
      this.uid = null
      this.reset()
      this.context.emit('internal/fork', this)
      const result = remove(runtime.disposables, this.dispose)
      if (remove(runtime.children, this) && !runtime.children.length) {
        parent.registry.delete(runtime.plugin)
      }
      return result
    }), Context.static, runtime)

    runtime.children.push(this)
    runtime.disposables.push(this.dispose)
    this.context.emit('internal/fork', this)
    this.init(error)
  }

  start() {
    if (super.start()) return true
    for (const fork of this.runtime.forkables) {
      this.ensure(async () => fork(this.context, this._config))
    }
  }

  update(config: any, forced?: boolean) {
    const oldConfig = this.config
    const state: EffectScope<C> = this.runtime.isForkable ? this : this.runtime
    if (state.config !== oldConfig) return
    let resolved: any
    try {
      resolved = resolveConfig(this.runtime.plugin, config)
    } catch (error) {
      this.context.emit('internal/error', error)
      return this.cancel(error)
    }
    const [hasUpdate, shouldRestart] = state.checkUpdate(resolved, forced)
    this.context.emit('internal/before-update', this, config)
    this.config = resolved
    state.config = resolved
    if (hasUpdate) {
      this.context.emit('internal/update', this, oldConfig)
    }
    if (shouldRestart) state.restart()
  }
}

export class MainScope<C extends Context = Context> extends EffectScope<C> {
  public value: any

  runtime = this
  schema: any
  name?: string
  inject: Dict<Inject.Meta> = Object.create(null)
  forkables: Function[] = []
  children: ForkScope<C>[] = []
  isReusable?: boolean = false
  isReactive?: boolean = false

  constructor(ctx: C, public plugin: Plugin, config: any, error?: any) {
    super(ctx, config)
    if (!plugin) {
      this.name = 'root'
      this.isActive = true
    } else {
      this.setup()
      this.init(error)
    }
  }

  get isForkable() {
    return this.forkables.length > 0
  }

  fork(parent: Context, config: any, error?: any) {
    return new ForkScope(parent, this, config, error)
  }

  dispose() {
    this.uid = null
    this.reset()
    this.context.emit('internal/runtime', this)
    return true
  }

  private setup() {
    const { name } = this.plugin
    if (name && name !== 'apply') this.name = name
    this.schema = this.plugin['Config'] || this.plugin['schema']
    this.inject = Inject.resolve(this.plugin['using'] || this.plugin['inject'])
    this.isReusable = this.plugin['reusable']
    this.isReactive = this.plugin['reactive']
    this.context.emit('internal/runtime', this)

    if (this.isReusable) {
      this.forkables.push(this.apply)
    }
  }

  private apply = (context: C, config: any) => {
    if (typeof this.plugin !== 'function') {
      return this.plugin.apply(context, config)
    } else if (isConstructor(this.plugin)) {
      // eslint-disable-next-line new-cap
      const instance = new this.plugin(context, config)
      const name = instance[Context.expose]
      if (name) {
        context.set(name, instance)
      }
      if (instance['fork']) {
        this.forkables.push(instance['fork'].bind(instance))
      }
      return instance
    } else {
      return this.plugin(context, config)
    }
  }

  reset() {
    super.reset()
    for (const fork of this.children) {
      fork.reset()
    }
  }

  start() {
    if (super.start()) return true
    if (!this.isReusable && this.plugin) {
      this.ensure(async () => this.value = this.apply(this.ctx, this._config))
    }
    for (const fork of this.children) {
      fork.start()
    }
  }

  update(config: C['config'], forced?: boolean) {
    if (this.isForkable) {
      const warning = new Error(`attempting to update forkable plugin "${this.plugin.name}", which may lead to unexpected behavior`)
      this.context.emit(this.ctx, 'internal/warning', warning)
    }
    const oldConfig = this.config
    let resolved: any
    try {
      resolved = resolveConfig(this.runtime.plugin || this.context.constructor, config)
    } catch (error) {
      this.context.emit('internal/error', error)
      return this.cancel(error)
    }
    const [hasUpdate, shouldRestart] = this.checkUpdate(resolved, forced)
    const state = this.children.find(fork => fork.config === oldConfig)
    this.config = resolved
    if (state) {
      this.context.emit('internal/before-update', state, config)
      state.config = resolved
      if (hasUpdate) {
        this.context.emit('internal/update', state, oldConfig)
      }
    }
    if (shouldRestart) this.restart()
  }
}
