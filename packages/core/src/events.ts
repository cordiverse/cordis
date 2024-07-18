import { Awaitable, defineProperty, Promisify, remove } from 'cosmokit'
import { Context } from './context.ts'
import { EffectScope, ForkScope, MainScope, ScopeStatus } from './scope.ts'
import { getTraceable, symbols } from './index.ts'
import ReflectService from './reflect.ts'

export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export type Parameters<F> = F extends (...args: infer P) => any ? P : never
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never
export type GetEvents<C extends Context> = C[typeof Context.events]

declare module './context.ts' {
  export interface Context {
    /* eslint-disable max-len */
    [Context.events]: Events<this>
    parallel<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): Promise<void>
    parallel<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): Promise<void>
    emit<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): void
    emit<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): void
    serial<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): Promisify<ReturnType<GetEvents<this>[K]>>
    serial<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): Promisify<ReturnType<GetEvents<this>[K]>>
    bail<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): ReturnType<GetEvents<this>[K]>
    bail<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): ReturnType<GetEvents<this>[K]>
    on<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K], options?: boolean | EventOptions): () => boolean
    once<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K], options?: boolean | EventOptions): () => boolean
    off<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K]): boolean
    start(): Promise<void>
    stop(): Promise<void>
    /* eslint-enable max-len */
  }
}

export interface EventOptions {
  prepend?: boolean
  global?: boolean
}

export interface Hook extends EventOptions {
  ctx: Context
  callback: (...args: any[]) => any
}

class Lifecycle {
  isActive = false
  _tasks = new Set<Promise<void>>()
  _hooks: Record<keyof any, Hook[]> = {}

  constructor(private ctx: Context) {
    defineProperty(this, symbols.tracker, {
      associate: 'lifecycle',
      property: 'ctx',
    })

    defineProperty(this.on('internal/listener', function (this: Context, name, listener, options: EventOptions) {
      const method = options.prepend ? 'unshift' : 'push'
      if (name === 'ready') {
        if (!this.lifecycle.isActive) return
        this.scope.ensure(async () => listener())
        return () => false
      } else if (name === 'dispose') {
        this.scope.disposables[method](listener as any)
        defineProperty(listener, 'name', 'event <dispose>')
        return () => remove(this.scope.disposables, listener)
      } else if (name === 'fork') {
        this.scope.runtime.forkables[method](listener as any)
        return this.scope.collect('event <fork>', () => remove(this.scope.runtime.forkables, listener))
      }
    }), Context.static, ctx.scope)

    for (const level of ['info', 'error', 'warning']) {
      defineProperty(this.on(`internal/${level}`, (format, ...param) => {
        if (this._hooks[`internal/${level}`].length > 1) return
        // eslint-disable-next-line no-console
        console.info(format, ...param)
      }), Context.static, ctx.scope)
    }

    // non-reusable plugin forks are not responsive to isolated service changes
    defineProperty(this.on('internal/before-service', function (this: Context, name) {
      for (const runtime of this.registry.values()) {
        if (!runtime.inject[name]?.required) continue
        const scopes = runtime.isReusable ? runtime.children : [runtime]
        for (const scope of scopes) {
          if (!this[symbols.filter](scope.ctx)) continue
          scope.updateStatus()
          scope.reset()
        }
      }
    }, { global: true }), Context.static, ctx.scope)

    defineProperty(this.on('internal/service', function (this: Context, name) {
      for (const runtime of this.registry.values()) {
        if (!runtime.inject[name]?.required) continue
        const scopes = runtime.isReusable ? runtime.children : [runtime]
        for (const scope of scopes) {
          if (!this[symbols.filter](scope.ctx)) continue
          scope.start()
        }
      }
    }, { global: true }), Context.static, ctx.scope)

    // inject in ancestor contexts
    const checkInject = (scope: EffectScope, name: string) => {
      if (!scope.runtime.plugin) return false
      for (const key in scope.runtime.inject) {
        if (name === ReflectService.resolveInject(scope.ctx, key)[0]) return true
      }
      return checkInject(scope.parent.scope, name)
    }

    defineProperty(this.on('internal/inject', function (this: Context, name) {
      return checkInject(this.scope, name)
    }, { global: true }), Context.static, ctx.scope)
  }

  async flush() {
    while (this._tasks.size) {
      await Promise.all(Array.from(this._tasks))
    }
  }

  filterHooks(hooks: Hook[], thisArg?: object) {
    thisArg = getTraceable(this.ctx, thisArg)
    return hooks.slice().filter((hook) => {
      const filter = thisArg?.[Context.filter]
      return hook.global || !filter || filter.call(thisArg, hook.ctx)
    })
  }

  * dispatch(type: string, args: any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name = args.shift()
    if (name !== 'internal/event') {
      this.emit('internal/event', type, name, args, thisArg)
    }
    for (const hook of this.filterHooks(this._hooks[name] || [], thisArg)) {
      yield hook.callback.apply(thisArg, args)
    }
  }

  async parallel(...args: any[]) {
    await Promise.all(this.dispatch('emit', args))
  }

  emit(...args: any[]) {
    Array.from(this.dispatch('emit', args))
  }

  async serial(...args: any[]) {
    for await (const result of this.dispatch('serial', args)) {
      if (isBailed(result)) return result
    }
  }

  bail(...args: any[]) {
    for (const result of this.dispatch('bail', args)) {
      if (isBailed(result)) return result
    }
  }

  register(label: string, hooks: Hook[], callback: any, options: EventOptions) {
    const method = options.prepend ? 'unshift' : 'push'
    hooks[method]({ ctx: this.ctx, callback, ...options })
    return this.ctx.state.collect(label, () => this.unregister(hooks, callback))
  }

  unregister(hooks: Hook[], callback: any) {
    const index = hooks.findIndex(hook => hook.callback === callback)
    if (index >= 0) {
      hooks.splice(index, 1)
      return true
    }
  }

  on(name: string, listener: (...args: any) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }

    // handle special events
    this.ctx.scope.assertActive()
    listener = this.ctx.reflect.bind(listener)
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result

    const hooks = this._hooks[name] ||= []
    const label = typeof name === 'string' ? `event <${name}>` : 'event (Symbol)'
    return this.register(label, hooks, listener, options)
  }

  once(name: string, listener: (...args: any) => any, options?: boolean | EventOptions) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, options)
    return dispose
  }

  async start() {
    this.isActive = true
    const hooks = this._hooks.ready || []
    while (hooks.length) {
      const { ctx, callback } = hooks.shift()!
      ctx.scope.ensure(async () => callback())
    }
    await this.flush()
  }

  async stop() {
    this.isActive = false
    // `dispose` event is handled by state.disposables
    this.ctx.scope.reset()
  }
}

export default Lifecycle

export interface Events<in C extends Context = Context> {
  'fork'(ctx: C, config: C['config']): void
  'ready'(): Awaitable<void>
  'dispose'(): Awaitable<void>
  'internal/fork'(fork: ForkScope<C>): void
  'internal/runtime'(runtime: MainScope<C>): void
  'internal/status'(scope: EffectScope<C>, oldValue: ScopeStatus): void
  'internal/info'(this: C, format: any, ...param: any[]): void
  'internal/error'(this: C, format: any, ...param: any[]): void
  'internal/warning'(this: C, format: any, ...param: any[]): void
  'internal/before-service'(this: C, name: string, value: any): void
  'internal/service'(this: C, name: string, value: any): void
  'internal/before-update'(fork: ForkScope<C>, config: any): void
  'internal/update'(fork: ForkScope<C>, oldConfig: any): void
  'internal/inject'(this: C, name: string): boolean | undefined
  'internal/listener'(this: C, name: string, listener: any, prepend: boolean): void
  'internal/event'(type: 'emit' | 'parallel' | 'serial' | 'bail', name: string, args: any[], thisArg: any): void
}
