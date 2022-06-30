import { Awaitable, defineProperty, Promisify, remove } from 'cosmokit'
import { Context } from './context'
import { Fork, Runtime } from './state'
import { Plugin } from './registry'

function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export namespace Lifecycle {
  export interface Config {
    maxListeners?: number
  }

  type Parameters<T> = T extends (...args: infer P) => any ? P : never
  type ReturnType<T> = T extends (...args: any) => infer R ? R : never

  export interface Mixin<S extends Events> {
    parallel<K extends keyof S>(name: K, ...args: Parameters<S[K]>): Promise<void>
    parallel<K extends keyof S>(thisArg: ThisParameterType<S[K]>, name: K, ...args: Parameters<S[K]>): Promise<void>
    emit<K extends keyof S>(name: K, ...args: Parameters<S[K]>): void
    emit<K extends keyof S>(thisArg: ThisParameterType<S[K]>, name: K, ...args: Parameters<S[K]>): void
    serial<K extends keyof S>(name: K, ...args: Parameters<S[K]>): Promisify<ReturnType<S[K]>>
    serial<K extends keyof S>(thisArg: ThisParameterType<S[K]>, name: K, ...args: Parameters<S[K]>): Promisify<ReturnType<S[K]>>
    bail<K extends keyof S>(name: K, ...args: Parameters<S[K]>): ReturnType<S[K]>
    bail<K extends keyof S>(thisArg: ThisParameterType<S[K]>, name: K, ...args: Parameters<S[K]>): ReturnType<S[K]>
    on<K extends keyof S>(name: K, listener: S[K], prepend?: boolean): () => boolean
    once<K extends keyof S>(name: K, listener: S[K], prepend?: boolean): () => boolean
    off<K extends keyof S>(name: K, listener: S[K]): boolean
    start(): Promise<void>
    stop(): Promise<void>
  }
}

export class Lifecycle {
  static methods = ['on', 'once', 'off', 'before', 'after', 'parallel', 'emit', 'serial', 'bail', 'start', 'stop']

  isActive = false
  _tasks = new Set<Promise<void>>()
  _hooks: Record<keyof any, [Context, (...args: any[]) => any][]> = {}

  constructor(private root: Context, private config: Lifecycle.Config) {
    const self = this as Lifecycle.Mixin<Events>
    defineProperty(this, Context.current, root)

    const dispose = self.on('internal/hook', function (name, listener, prepend) {
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
    })
    defineProperty(dispose, Context.static, true)
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
    if (hooks.length >= this.config.maxListeners) {
      this.root.emit('internal/warning', `max listener count (${this.config.maxListeners}) for ${label} exceeded, which may be caused by a memory leak`)
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

  on(name: keyof any, listener: Function, prepend = false) {
    // handle special events
    const result = this.bail(this, 'internal/hook', name, listener, prepend)
    if (result) return result

    const hooks = this._hooks[name] ||= []
    const label = typeof name === 'string' ? `event <${name}>` : 'event (Symbol)'
    return this.register(label, hooks, listener, prepend)
  }

  once(name: keyof any, listener: Function, prepend = false) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, prepend)
    return dispose
  }

  off(name: keyof any, listener: Function) {
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

export interface Events {
  'fork': Plugin.Function
  'ready'(): Awaitable<void>
  'dispose'(): Awaitable<void>
  'internal/fork'(fork: Fork): void
  'internal/runtime'(runtime: Runtime): void
  'internal/warning'(format: any, ...param: any[]): void
  'internal/service'(name: string): void
  'internal/update'(fork: Fork, config: any): void
  'internal/hook'(this: Lifecycle, name: string, listener: Function, prepend: boolean): () => boolean
}
