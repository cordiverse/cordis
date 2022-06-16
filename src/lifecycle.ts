import { Awaitable, defineProperty, Promisify, remove } from 'cosmokit'
import { Context } from './context'
import { Fork, Runtime } from './state'
import { Plugin } from './plugin'

function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export namespace Lifecycle {
  export interface Config {
    maxListeners?: number
  }

  export interface Delegates {
    parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
    parallel<K extends keyof Events>(thisArg: ThisParameterType<Events[K]>, name: K, ...args: Parameters<Events[K]>): Promise<void>
    emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
    emit<K extends keyof Events>(thisArg: ThisParameterType<Events[K]>, name: K, ...args: Parameters<Events[K]>): void
    waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    waterfall<K extends keyof Events>(thisArg: ThisParameterType<Events[K]>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    chain<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    chain<K extends keyof Events>(thisArg: ThisParameterType<Events[K]>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    serial<K extends keyof Events>(thisArg: ThisParameterType<Events[K]>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    bail<K extends keyof Events>(thisArg: ThisParameterType<Events[K]>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    on<K extends keyof Events>(name: K, listener: Events[K], prepend?: boolean): () => boolean
    once<K extends keyof Events>(name: K, listener: Events[K], prepend?: boolean): () => boolean
    off<K extends keyof Events>(name: K, listener: Events[K]): boolean
  }
}

export class Lifecycle {
  isActive = false
  #tasks = new Set<Promise<void>>()
  _hooks: Record<keyof any, [Context, (...args: any[]) => any][]> = {}

  constructor(private ctx: Context, private config: Lifecycle.Config) {
    const self = this as Lifecycle.Delegates

    self.on('internal/hook', (name, listener, prepend) => {
      const method = prepend ? 'unshift' : 'push'
      const { runtime, disposables } = this.caller.state
      if (name === 'ready' && this.isActive) {
        this.queue(listener())
        return () => false
      } else if (name === 'dispose') {
        disposables[method](listener as any)
        defineProperty(listener, 'name', 'event <dispose>')
        return () => remove(disposables, listener)
      } else if (name === 'fork') {
        runtime.forkables[method](listener as any)
        return this.mark('event <fork>', () => remove(runtime.forkables, listener))
      }
    })
  }

  protected get caller(): Context {
    return this[Context.current] || this.ctx
  }

  queue(value: any) {
    const task = Promise.resolve(value)
      .catch(reason => this.ctx.emit('internal/warn', reason))
      .then(() => this.#tasks.delete(task))
    this.#tasks.add(task)
  }

  async flush() {
    while (this.#tasks.size) {
      await Promise.all(Array.from(this.#tasks))
    }
  }

  * getHooks(name: keyof Events, thisArg?: object) {
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
        this.ctx.emit('internal/warn', error)
      }
    }))
  }

  emit(...args: any[]) {
    this.parallel(...args)
  }

  async waterfall(...args: [any, ...any[]]) {
    const thisArg = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const callback of this.getHooks(name, thisArg)) {
      const result = await callback.apply(thisArg, args)
      args[0] = result
    }
    return args[0]
  }

  chain(...args: [any, ...any[]]) {
    const thisArg = typeof args[0] === 'object' ? args.shift() : null
    const name = args.shift()
    for (const callback of this.getHooks(name, thisArg)) {
      const result = callback.apply(thisArg, args)
      args[0] = result
    }
    return args[0]
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

  mark(label: string, callback: () => boolean) {
    const { disposables } = this.caller.state
    const dispose = () => {
      remove(disposables, dispose)
      return callback()
    }
    disposables.push(dispose)
    defineProperty(dispose, 'name', label)
    return dispose
  }

  register(label: string, hooks: [Context, any][], listener: any, prepend?: boolean) {
    if (hooks.length >= this.config.maxListeners) {
      this.ctx.emit('internal/warn', `max listener count (${this.config.maxListeners}) for ${label} exceeded, which may be caused by a memory leak`)
    }

    const method = prepend ? 'unshift' : 'push'
    hooks[method]([this.caller, listener])
    return this.mark(label, () => this.unregister(hooks, listener))
  }

  unregister(hooks: [Context, any][], listener: any) {
    const index = hooks.findIndex(([context, callback]) => callback === listener)
    if (index >= 0) {
      hooks.splice(index, 1)
      return true
    }
  }

  on(name: keyof Events, listener: Function, prepend = false) {
    // handle special events
    const result = this.bail('internal/hook', name, listener, prepend)
    if (result) return result

    const hooks = this._hooks[name] ||= []
    const label = typeof name === 'string' ? `event <${name}>` : 'event (Symbol)'
    return this.register(label, hooks, listener, prepend)
  }

  once(name: keyof Events, listener: Function, prepend = false) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, prepend)
    return dispose
  }

  off<K extends keyof Events>(name: K, listener: Events[K]) {
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
    // `dispose` event is handled by ctx.disposables
    await Promise.all(this.ctx.state.disposables.map(dispose => dispose()))
  }
}

export interface Events {
  'plugin-added'(state: Runtime): void
  'plugin-removed'(state: Runtime): void
  'ready'(): Awaitable<void>
  'fork': Plugin.Function
  'dispose'(): Awaitable<void>
  'internal/warn'(format: any, ...param: any[]): void
  'internal/service'(this: Context, name: string, oldValue: any): void
  'internal/update'(state: Fork, config: any): void
  'internal/hook'(name: string, listener: Function, prepend: boolean): () => boolean
}
