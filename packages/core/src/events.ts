import { Awaitable, defineProperty, Promisify, remove } from 'cosmokit'
import { Context } from './context.ts'
import { EffectScope, ForkScope, MainScope, ScopeStatus } from './scope.ts'
import { symbols } from './index.ts'

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

type Hook = [Context, (...args: any[]) => any, EventOptions]

export class Lifecycle {
  isActive = false
  _tasks = new Set<Promise<void>>()
  _hooks: Record<keyof any, Hook[]> = {}

  constructor(private ctx: Context) {
    defineProperty(this, Context.origin, ctx)

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
        if (!runtime.using.includes(name)) continue
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
        if (!runtime.using.includes(name)) continue
        const scopes = runtime.isReusable ? runtime.children : [runtime]
        for (const scope of scopes) {
          if (!this[symbols.filter](scope.ctx)) continue
          scope.start()
        }
      }
    }, { global: true }), Context.static, ctx.scope)

    // inject in ancestor contexts
    defineProperty(this.on('internal/inject', function (name) {
      let parent = this
      while (parent.runtime.plugin) {
        for (const key of parent.runtime.inject) {
          if (name === Context.resolveInject(parent, key)[0]) return true
        }
        parent = parent.scope.parent
      }
    }, { global: true }), Context.static, ctx.scope)
  }

  async flush() {
    while (this._tasks.size) {
      await Promise.all(Array.from(this._tasks))
    }
  }

  getHooks(name: keyof any, thisArg?: object) {
    const hooks = this._hooks[name] || []
    return hooks.slice().filter(([context, callback, options]) => {
      const filter = thisArg?.[Context.filter]
      return options.global || !filter || filter.call(thisArg, context)
    }).map(([, callback]) => callback)
  }

  prepareEvent(type: string, args: any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name = args.shift()
    if (name !== 'internal/event') {
      this.emit('internal/event', type, name, args, thisArg)
    }
    return [this.getHooks(name, thisArg), thisArg ?? this.ctx] as const
  }

  async parallel(...args: any[]) {
    const [hooks, thisArg] = this.prepareEvent('parallel', args)
    await Promise.all(hooks.map(async (callback) => {
      await callback.apply(thisArg, args)
    }))
  }

  emit(...args: any[]) {
    const [hooks, thisArg] = this.prepareEvent('emit', args)
    for (const callback of hooks) {
      callback.apply(thisArg, args)
    }
  }

  async serial(...args: any[]) {
    const [hooks, thisArg] = this.prepareEvent('serial', args)
    for (const callback of hooks) {
      const result = await callback.apply(thisArg, args)
      if (isBailed(result)) return result
    }
  }

  bail(...args: any[]) {
    const [hooks, thisArg] = this.prepareEvent('bail', args)
    for (const callback of hooks) {
      const result = callback.apply(thisArg, args)
      if (isBailed(result)) return result
    }
  }

  register(label: string, hooks: Hook[], listener: any, options: EventOptions) {
    const method = options.prepend ? 'unshift' : 'push'
    hooks[method]([this.ctx, listener, options])
    return this.ctx.state.collect(label, () => this.unregister(hooks, listener))
  }

  unregister(hooks: Hook[], listener: any) {
    const index = hooks.findIndex(([context, callback]) => callback === listener)
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

  off(name: string, listener: (...args: any) => any) {
    return this.unregister(this._hooks[name] || [], listener)
  }

  async start() {
    this.isActive = true
    const hooks = this._hooks.ready || []
    while (hooks.length) {
      const [context, callback] = hooks.shift()!
      context.scope.ensure(async () => callback())
    }
    await this.flush()
  }

  async stop() {
    this.isActive = false
    // `dispose` event is handled by state.disposables
    this.ctx.scope.reset()
  }
}

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
