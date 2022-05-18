import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context'
import { Lifecycle } from './lifecycle'
import { Plugin, Registry } from './plugin'

export * from './context'
export * from './lifecycle'
export * from './plugin'

export interface Events {
  'plugin-added'(state: Plugin.State): void
  'plugin-removed'(state: Plugin.State): void
  'ready'(): Awaitable<void>
  'dispose'(): Awaitable<void>
  'service'(name: string): void
}

export interface Services {
  lifecycle: Lifecycle
  registry: Registry
  services: Services
}

export namespace Services {
  export interface Options {
    methods?: string[]
  }

  export function register(name: string, options: Options = {}) {
    if (Object.prototype.hasOwnProperty.call(Context.prototype, name)) return
    Object.defineProperty(Context.prototype, name, {
      get(this: Context) {
        const value = this.services[name]
        if (!value) return
        defineProperty(value, Context.current, this)
        return value
      },
      set(this: Context, value) {
        const oldValue = this.services[name]
        if (oldValue === value) return
        this.services[name] = value
        this.emit('service', name)
        const action = value ? oldValue ? 'changed' : 'enabled' : 'disabled'
        this.logger('service').debug(name, action)
      },
    })

    for (const method of options.methods || []) {
      defineProperty(Context.prototype, method, function (this: Context, ...args: any[]) {
        return this[name][method](...args)
      })
    }
  }

  register('registry', {
    methods: ['plugin', 'dispose'],
  })

  register('lifecycle', {
    methods: ['on', 'once', 'off', 'before', 'after', 'parallel', 'emit', 'serial', 'bail', 'waterfall', 'chain'],
  })
}

export interface Session {}
