import { deepEqual, defineProperty, Promisify } from 'cosmokit'
import { Context } from './context'
import { EffectScope, ScopeStatus } from './scope'
import { symbols } from './utils'

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
    waterfall<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): ReturnType<GetEvents<this>[K]>
    waterfall<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): ReturnType<GetEvents<this>[K]>
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
      noShadow: true,
    })

    // TODO: deprecate these events
    this.on('internal/listener', function (this: Context, name, listener, options: EventOptions) {
      if (name === 'ready') {
        Promise.resolve().then(listener)
        return () => false
      } else if (name === 'dispose') {
        defineProperty(listener, 'name', 'event <dispose>')
        return this.scope.disposables.push(listener)
      } else if (name === 'internal/update' && !options.global) {
        return this.scope.acceptors.push(listener)
      }
    })

    for (const level of ['info', 'error', 'warning']) {
      this.on(`internal/${level}`, (format, ...param) => {
        if (this._hooks[`internal/${level}`].length > 1) return
        // eslint-disable-next-line no-console
        console.info(format, ...param)
      })
    }

    this.on('internal/before-service', function (this: Context, name) {
      for (const runtime of this.registry.values()) {
        for (const scope of runtime.scopes) {
          if (!scope.inject[name]?.required) continue
          if (!this[symbols.filter](scope.ctx)) continue
          scope.active = false
        }
      }
    }, { global: true })

    this.on('internal/service', function (this: Context, name) {
      for (const runtime of this.registry.values()) {
        for (const scope of runtime.scopes) {
          if (!scope.inject[name]?.required) continue
          if (!this[symbols.filter](scope.ctx)) continue
          scope.active = true
        }
      }
    }, { global: true })

    this.on('internal/status', function (scope: EffectScope) {
      if (scope.status !== ScopeStatus.ACTIVE) return
      for (const key of Reflect.ownKeys(ctx[symbols.store])) {
        const item = ctx[symbols.store][key as symbol]
        if (item.source.scope !== scope) continue
        if (item.value) {
          item.source.emit(item.source, 'internal/service', item.name, item.value)
        }
      }
    }, { global: true })

    this.on('internal/inject', function (this: Context, name: string, key: symbol) {
      const provider = this[symbols.store][key]?.source.scope
      let scope = this.scope
      while (true) {
        if (scope === provider) return true
        const inject = scope.inject[name]
        if (inject) {
          if (inject.required && !scope.store) return `cannot get required service "${name}" in inactive context`
          return true
        }
        if (scope.parent[symbols.isolate][name] !== key) break
        const next = scope.parent.scope
        if (scope === next) break
        scope = next
      }
      return false
    }, { global: true })

    this.on('internal/update', (scope, config) => {
      for (const acceptor of scope.acceptors) {
        if (acceptor(scope, config)) return true
      }
      return deepEqual(scope.config, config)
    }, { global: true })
  }

  dispatch(type: string, args: any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name: string = args.shift()
    if (!name.startsWith('internal/')) {
      this.emit('internal/event', type, name, args, thisArg)
    }
    const filter = thisArg?.[Context.filter]
    return (this._hooks[name] || [])
      .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
      .map(hook => hook.callback.bind(thisArg))
  }

  async parallel(...args: any[]) {
    await Promise.all(this.dispatch('emit', args).map(cb => cb(...args)))
  }

  emit(...args: any[]) {
    this.dispatch('emit', args).map(cb => cb(...args))
  }

  async serial(...args: any[]) {
    for (const cb of this.dispatch('serial', args)) {
      const result = await cb(...args)
      if (isBailed(result)) return result
    }
  }

  bail(...args: any[]) {
    for (const cb of this.dispatch('bail', args)) {
      const result = cb(...args)
      if (isBailed(result)) return result
    }
  }

  waterfall(...args: any[]) {
    const cbs = this.dispatch('waterfall', args)
    const inner = args.pop()
    const next = () => {
      const cb = cbs.shift() ?? inner
      return cb(...args)
    }
    args.push(next)
    return next()
  }

  register(label: string, hooks: Hook[], callback: any, options: EventOptions): () => void {
    const method = options.prepend ? 'unshift' : 'push'
    return this.ctx.scope.effect(() => {
      hooks[method]({ ctx: this.ctx, callback, ...options })
      return () => this.unregister(hooks, callback)
    }, label)
  }

  unregister(hooks: Hook[], callback: any) {
    const index = hooks.findIndex(hook => hook.callback === callback)
    if (index >= 0) {
      hooks.splice(index, 1)
      return true
    }
  }

  on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }

    // handle special events
    this.ctx.scope.assertActive()
    listener = this.ctx.reflect.bind(listener)
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result

    const hooks = this._hooks[name] ||= []
    const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
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
  'internal/plugin'(scope: EffectScope<C>): void
  'internal/status'(scope: EffectScope<C>, oldValue: ScopeStatus): void
  'internal/info'(this: C, format: any, ...param: any[]): void
  'internal/error'(this: C, format: any, ...param: any[]): void
  'internal/warning'(this: C, format: any, ...param: any[]): void
  'internal/before-service'(this: C, name: string, value: any): void
  'internal/service'(this: C, name: string, value: any): void
  'internal/update'(scope: EffectScope<C>, config: any): boolean | void
  'internal/inject'(this: C, name: string, key: symbol): boolean | string
  'internal/listener'(this: C, name: string, listener: any, prepend: boolean): void
  'internal/event'(type: 'emit' | 'parallel' | 'serial' | 'bail', name: string, args: any[], thisArg: any): void
}
