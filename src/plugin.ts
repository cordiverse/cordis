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

  export interface State {
    runtime: Runtime
    context: Context
    config: any
    disposables: Disposable[]
  }

  const prevent = Symbol('prevent')

  export class Runtime implements State {
    id = ''
    runtime = this
    context: Context
    schema: any
    using: readonly string[]
    disposables: Disposable[] = []
    forkers: Function[] = []
    children: State[] = []
    isActive = false

    constructor(private registry: Registry, public plugin: Plugin, public config: any) {
      this.context = new Context((session) => {
        return this.children.some(p => p.context.match(session))
      }, registry.app, this)
      registry.set(plugin, this)
      if (plugin) this.start()
    }

    [Symbol.for('nodejs.util.inspect.custom')]() {
      return `Runtime <${this.context.source}>`
    }

    fork(context: Context, config: any) {
      const dispose = () => {
        state.disposables.splice(0, Infinity).forEach(dispose => dispose())
        remove(this.disposables, dispose)
        if (remove(this.children, state) && !this.children.length) {
          this.dispose()
        }
        return remove(context.state.disposables, dispose)
      }
      defineProperty(dispose, prevent, true)
      defineProperty(dispose, 'name', `state <${context.source}>`)
      const state: State = {
        runtime: this,
        config,
        context: null,
        disposables: [],
      }
      state.context = new Context(context.filter, context.app, state)
      this.children.push(state)
      this.disposables.push(dispose)
      context.state?.disposables.push(dispose)
      if (this.isActive) {
        this.executeFork(state)
      }
      return dispose
    }

    dispose() {
      this.disposables.splice(0, Infinity).forEach(dispose => dispose())
      if (this.plugin) this.stop()
      return this
    }

    start() {
      this.schema = this.plugin['Config'] || this.plugin['schema']
      this.using = this.plugin['using'] || []
      this.id = Math.random().toString(36).slice(2, 10)
      this.registry.app.emit('plugin-added', this)
      this.registry.app.emit('logger/debug', 'app', 'plugin:', this.plugin.name)

      if (this.plugin['reusable']) {
        this.forkers.push(this.apply)
      }

      if (this.using.length) {
        const dispose = this.context.on('service', (name) => {
          if (!this.using.includes(name)) return
          this.disposables = this.disposables.filter(dispose => {
            if (dispose[prevent]) return true
            dispose()
          })
          this.callback()
        })
        dispose[prevent] = true
      }

      this.callback()
    }

    stop() {
      this.registry.delete(this.plugin)
      this.context.emit('logger/debug', 'app', 'dispose:', this.plugin.name)
      this.context.emit('plugin-removed', this)
    }

    private executeFork(state: State) {
      for (const fork of this.forkers) {
        fork(state.context, state.config)
      }
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

    private callback() {
      if (this.using.some(name => !this.context[name])) return

      // execute plugin body
      this.isActive = true
      if (!this.plugin['reusable']) {
        this.apply(this.context, this.config)
      }

      for (const state of this.children) {
        this.executeFork(state)
      }
    }
  }
}
