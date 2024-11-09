import { Awaitable, defineProperty, Promisify } from 'cosmokit'
import { Context } from './context'
import { EffectScope, ScopeStatus } from './scope'
import { getTraceable, symbols } from './utils'
import ReflectService from './reflect'

export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export type Parameters<F> = F extends (...args: infer P) => any ? P : never
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never
export type GetEvents<C extends Context> = C[typeof Context.events]

declare module './context' {
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

class EventsService {
  _hooks: Record<keyof any, Hook[]> = {}

  constructor(private ctx: Context) {
    defineProperty(this, symbols.tracker, {
      associate: 'events',
      property: 'ctx',
    })

    // TODO: deprecate these events
    ctx.scope.leak(this.on('internal/listener', function (this: Context, name, listener, options: EventOptions) {
      if (name === 'ready') {
        Promise.resolve().then(listener)
        return () => false
      } else if (name === 'dispose') {
        defineProperty(listener, 'name', 'event <dispose>')
        return this.scope.disposables.push(listener)
      }
    }))

    for (const level of ['info', 'error', 'warning']) {
      ctx.scope.leak(this.on(`internal/${level}`, (format, ...param) => {
        if (this._hooks[`internal/${level}`].length > 1) return
        // eslint-disable-next-line no-console
        console.info(format, ...param)
      }))
    }

    ctx.scope.leak(this.on('internal/before-service', function (this: Context, name) {
      for (const runtime of this.registry.values()) {
        if (!runtime.inject[name]?.required) continue
        for (const scope of runtime.scopes) {
          if (!this[symbols.filter](scope.ctx)) continue
          scope.updateStatus()
          scope.reset()
        }
      }
    }, { global: true }))

    ctx.scope.leak(this.on('internal/service', function (this: Context, name) {
      for (const runtime of this.registry.values()) {
        if (!runtime.inject[name]?.required) continue
        for (const scope of runtime.scopes) {
          if (!this[symbols.filter](scope.ctx)) continue
          scope.start()
        }
      }
    }, { global: true }))

    ctx.scope.leak(this.on('internal/status', function (scope: EffectScope) {
      if (scope.status !== ScopeStatus.ACTIVE) return
      for (const key of Reflect.ownKeys(ctx[symbols.store])) {
        const item = ctx[symbols.store][key as symbol]
        if (item.source.scope !== scope) continue
        if (item.value) {
          item.source.emit(item.source, 'internal/service', item.name, item.value)
        }
      }
    }, { global: true }))

    ctx.scope.leak(this.on('internal/inject', function (this: Context, name, provider) {
      const visited = new Set<string>()
      let scope = this.scope
      while (1) {
        if (scope === provider) return true
        for (const key in scope.runtime?.inject ?? {}) {
          if (visited.has(key)) continue
          visited.add(key)
          if (name === ReflectService.resolveInject(scope.ctx, key)[0]) return true
        }
        const next = scope.parent.scope
        if (scope === next) break
        scope = next
      }
      return false
    }, { global: true }))
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
    return this.ctx.scope.effect(() => {
      hooks[method]({ ctx: this.ctx, callback, ...options })
      return () => this.unregister(hooks, callback)
    })
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
}

export default EventsService

export interface Events<in C extends Context = Context> {
  'ready'(): Awaitable<void>
  'dispose'(): Awaitable<void>
  'internal/plugin'(fork: EffectScope<C>): void
  'internal/status'(scope: EffectScope<C>, oldValue: ScopeStatus): void
  'internal/info'(this: C, format: any, ...param: any[]): void
  'internal/error'(this: C, format: any, ...param: any[]): void
  'internal/warning'(this: C, format: any, ...param: any[]): void
  'internal/before-service'(this: C, name: string, value: any): void
  'internal/service'(this: C, name: string, value: any): void
  'internal/before-update'(fork: EffectScope<C>, config: any): void
  'internal/update'(fork: EffectScope<C>, oldConfig: any): void
  'internal/inject'(this: C, name: string, provider?: EffectScope): boolean | undefined
  'internal/listener'(this: C, name: string, listener: any, prepend: boolean): void
  'internal/event'(type: 'emit' | 'parallel' | 'serial' | 'bail', name: string, args: any[], thisArg: any): void
}
