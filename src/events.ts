import { Awaitable, defineProperty, Promisify, remove } from 'cosmokit'
import { Context } from './context'
import { Fork, Runtime } from './state'
import { Plugin } from './registry'

export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export type Parameters<F> = F extends (...args: infer P) => any ? P : never
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never
export type GetEvents<C extends Context> = C[typeof Context.events]

declare module './context' {
  export interface Context {
    [Context.events]: Events<this>
    parallel<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): Promise<void>
    parallel<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): Promise<void>
    emit<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): void
    emit<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): void
    serial<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): Promisify<ReturnType<GetEvents<this>[K]>>
    serial<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): Promisify<ReturnType<GetEvents<this>[K]>>
    bail<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): ReturnType<GetEvents<this>[K]>
    bail<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): ReturnType<GetEvents<this>[K]>
    on<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K], prepend?: boolean): () => boolean
    once<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K], prepend?: boolean): () => boolean
    off<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K]): boolean
    start(): Promise<void>
    stop(): Promise<void>
  }
}

export namespace Lifecycle {
  export interface Config {
    maxListeners?: number
  }
}

export class Lifecycle {
  static readonly methods = ['on', 'once', 'off', 'before', 'after', 'parallel', 'emit', 'serial', 'bail', 'start', 'stop']

  isActive = false
  _tasks = new Set<Promise<void>>()
  _hooks: Record<keyof any, [Context, (...args: any[]) => any][]> = {}

  constructor(private root: Context) {
    defineProperty(this, Context.current, root)
    defineProperty(this.on('internal/hook', function (name, listener, prepend) {
      const method = prepend ? 'unshift' : 'push'
      const { state } = this[Context.current]
      const { runtime, disposables } = state
      if (name === 'ready' && this.isActive) {
        this.queue(listener())
      } else if (name === 'dispose') {
        disposables[method](listener as any)
        defineProperty(listener, 'name', 'event <dispose>')
        return () => remove(disposables, listener)
      } else if (name === 'fork') {
        runtime.forkables[method](listener as any)
        return state.collect('event <fork>', () => remove(runtime.forkables, listener))
      }
    }), Context.static, root.state)
  }

  queue(value: any) {
    const task = Promise.resolve(value)
      .catch(reason => this.root.emit('internal/warning', reason))
      .then(() => this._tasks.delete(task))
    this._tasks.add(task)
  }

  async flush() {
    while (this._tasks.size) {
      await Promise.all(Array.from(this._tasks))
    }
  }

  * getHooks(name: keyof any, thisArg?: object) {
    const hooks = this._hooks[name] || []
    for (const [context, callback] of hooks.slice()) {
      const filter = thisArg?.[Context.filter]
      if (filter && !filter.call(thisArg, context)) continue
      yield callback
    }
  }

  async parallel(...args: any[]) {
    const thisArg = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    await Promise.all([...this.getHooks(name, thisArg)].map(async (callback) => {
      try {
        await callback.apply(thisArg, args)
      } catch (error) {
        this.root.emit('internal/warning', error)
      }
    }))
  }

  emit(...args: any[]) {
    this.parallel(...args)
  }

  async serial(...args: any[]) {
    const thisArg = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const callback of this.getHooks(name, thisArg)) {
      const result = await callback.apply(thisArg, args)
      if (isBailed(result)) return result
    }
  }

  bail(...args: any[]) {
    const thisArg = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const callback of this.getHooks(name, thisArg)) {
      const result = callback.apply(thisArg, args)
      if (isBailed(result)) return result
    }
  }

  register(label: string, hooks: [Context, any][], listener: any, prepend?: boolean) {
    const maxListeners = this.root.config.maxListeners!
    if (hooks.length >= maxListeners!) {
      this.root.emit('internal/warning', `max listener count (${maxListeners!}) for ${label} exceeded, which may be caused by a memory leak`)
    }

    const caller = this[Context.current]
    const method = prepend ? 'unshift' : 'push'
    hooks[method]([caller, listener])
    return caller.state.collect(label, () => this.unregister(hooks, listener))
  }

  unregister(hooks: [Context, any][], listener: any) {
    const index = hooks.findIndex(([context, callback]) => callback === listener)
    if (index >= 0) {
      hooks.splice(index, 1)
      return true
    }
  }

  on(name: keyof any, listener: (...args: any) => any, prepend = false) {
    // handle special events
    const result = this.bail(this, 'internal/hook', name, listener, prepend)
    if (result) return result

    const hooks = this._hooks[name] ||= []
    const label = typeof name === 'string' ? `event <${name}>` : 'event (Symbol)'
    return this.register(label, hooks, listener, prepend)
  }

  once(name: keyof any, listener: (...args: any) => any, prepend = false) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, prepend)
    return dispose
  }

  off(name: keyof any, listener: (...args: any) => any) {
    return this.unregister(this._hooks[name] || [], listener)
  }

  async start() {
    this.isActive = true
    for (const callback of this.getHooks('ready')) {
      this.queue(callback())
    }
    delete this._hooks.ready
    await this.flush()
  }

  async stop() {
    this.isActive = false
    // `dispose` event is handled by state.disposables
    this.root.state.clear(true)
  }
}

export interface Events<C extends Context = Context> {
  'fork': Plugin.Function<C['config'], C>
  'ready'(): Awaitable<void>
  'dispose'(): Awaitable<void>
  'internal/fork'(fork: Fork<Context.Parameterized<C>>): void
  'internal/runtime'(runtime: Runtime<Context.Parameterized<C>>): void
  'internal/warning'(format: any, ...param: any[]): void
  'internal/before-service'(name: string, value: any): void
  'internal/service'(name: string, oldValue: any): void
  'internal/before-update'(fork: Fork<Context.Parameterized<C>>, config: any): void
  'internal/update'(fork: Fork<Context.Parameterized<C>>, oldConfig: any): void
  'internal/hook'(this: Lifecycle, name: string, listener: Function, prepend: boolean): () => boolean
}
