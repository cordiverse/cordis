import { defineProperty, remove } from 'cosmokit'
import { Context } from './context'
import { Registry } from './registry'

function isConstructor(func: Function) {
  // async function or arrow function
  if (!func.prototype) return false
  // generator function or malformed definition
  if (func.prototype.constructor !== func) return false
  return true
}

export type Disposable = () => void

export type Plugin = Plugin.Function | Plugin.Object

export namespace Plugin {
  export type Function<T = any> = (ctx: Context, options: T) => void
  export type Constructor<T = any> = new (ctx: Context, options: T) => void

  export interface Object<S = any, T = any> {
    name?: string
    apply: Function<T>
    reusable?: boolean
    Config?: (config?: S) => T
    schema?: (config?: S) => T
    using?: readonly string[]
  }

  export type Config<T extends Plugin> =
    | T extends Constructor<infer U> ? U
    : T extends Function<infer U> ? U
    : T extends Object<infer U> ? U
    : never

  export abstract class State {
    id = Math.random().toString(36).slice(2, 10)
    runtime: Runtime
    context: Context
    disposables: Disposable[] = []

    abstract restart(): void

    constructor(public parent: Context, public config: any) {
      this.context = parent.fork({ state: this })
    }

    update(config: any) {
      config = Registry.validate(this.runtime.plugin, config)
      this.config = config
      this.restart()
    }

    protected reset(preserve = false) {
      this.disposables = this.disposables.splice(0, Infinity).filter((dispose) => {
        if (preserve && dispose[kPreserve]) return true
        dispose()
      })
    }
  }

  export const kPreserve = Symbol('preserve')

  export class Fork extends State {
    constructor(parent: Context, config: any, runtime: Runtime) {
      super(parent, config)
      this.runtime = runtime
      this.dispose = this.dispose.bind(this)
      defineProperty(this.dispose, kPreserve, true)
      defineProperty(this.dispose, 'name', `state <${parent.source}>`)
      runtime.children.push(this)
      runtime.disposables.push(this.dispose)
      parent.state?.disposables.push(this.dispose)
      this.restart()
    }

    restart() {
      this.reset(true)
      if (!this.runtime.isActive) return
      for (const fork of this.runtime.forkers) {
        fork(this.context, this.config)
      }
    }

    dispose() {
      this.reset()
      remove(this.runtime.disposables, this.dispose)
      if (remove(this.runtime.children, this) && !this.runtime.children.length) {
        this.runtime.dispose()
      }
      return remove(this.parent.state.disposables, this.dispose)
    }
  }

  export class Runtime extends State {
    runtime = this
    schema: any
    using: readonly string[] = []
    forkers: Function[] = []
    children: Fork[] = []
    isActive = false

    constructor(private registry: Registry, public plugin: Plugin, config: any) {
      super(registry.caller, config)
      this.context.filter = (session) => {
        return this.children.some(p => p.context.match(session))
      }
      registry.set(plugin, this)
      if (plugin) this.init()
    }

    fork(parent: Context, config: any) {
      return new Fork(parent, config, this)
    }

    dispose() {
      this.reset()
      if (this.plugin) {
        this.registry.delete(this.plugin)
        this.context.emit('logger/debug', 'app', 'dispose:', this.plugin.name)
        this.context.emit('plugin-removed', this)
      }
      return this
    }

    init() {
      this.schema = this.plugin['Config'] || this.plugin['schema']
      this.using = this.plugin['using'] || []
      this.registry.app.emit('plugin-added', this)
      this.registry.app.emit('logger/debug', 'app', 'plugin:', this.plugin.name)

      if (this.plugin['reusable']) {
        this.forkers.push(this.apply)
      }

      if (this.using.length) {
        const dispose = this.context.on('service', (name) => {
          if (!this.using.includes(name)) return
          this.restart()
        })
        defineProperty(dispose, kPreserve, true)
      }

      this.restart()
    }

    private apply = (context: Context, config: any) => {
      if (typeof this.plugin !== 'function') {
        this.plugin.apply(context, config)
      } else if (isConstructor(this.plugin)) {
        // eslint-disable-next-line new-cap
        const instance = new this.plugin(context, config)
        const name = instance[Context.immediate]
        if (name) {
          context[name] = instance
        }
      } else {
        this.plugin(context, config)
      }
    }

    restart() {
      this.reset(true)
      if (this.using.some(name => !this.context[name])) return

      // execute plugin body
      this.isActive = true
      if (!this.plugin['reusable']) {
        this.apply(this.context, this.config)
      }

      for (const state of this.children) {
        state.restart()
      }
    }
  }
}
