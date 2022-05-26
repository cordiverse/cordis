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
    id: string
    runtime: Runtime
    parent: Context
    context: Context
    config: any
    disposables: Disposable[]
  }

  export interface Fork extends State {
    (): boolean
  }

  export const kState = Symbol('state')

  export class Runtime implements State {
    id = Math.random().toString(36).slice(2, 10)
    runtime = this
    parent: Context
    context: Context
    schema: any
    using: readonly string[]
    disposables: Disposable[] = []
    forkers: Function[] = []
    children: Fork[] = []
    isActive = false

    constructor(private registry: Registry, public plugin: Plugin, public config: any) {
      this.parent = registry.caller
      this.context = new Context((session) => {
        return this.children.some(p => p.context.match(session))
      }, registry.app, this)
      registry.set(plugin, this)
      if (plugin) this.start()
    }

    [Symbol.for('nodejs.util.inspect.custom')]() {
      return `Runtime <${this.context.source}>`
    }

    fork(parent: Context, config: any) {
      const state: Fork = () => {
        state.disposables.splice(0, Infinity).forEach(dispose => dispose())
        remove(this.disposables, state)
        if (remove(this.children, state) && !this.children.length) {
          this.dispose()
        }
        return remove(parent.state.disposables, state)
      }
      state.id = Math.random().toString(36).slice(2, 10)
      state.parent = parent
      state.runtime = this
      state.context = new Context(parent.filter, parent.app, state)
      state.config = config
      state.disposables = []
      defineProperty(state, kState, true)
      defineProperty(state, 'name', `state <${parent.source}>`)
      this.children.push(state)
      this.disposables.push(state)
      parent.state?.disposables.push(state)
      if (this.isActive) {
        this.executeFork(state)
      }
      return state
    }

    dispose() {
      this.disposables.splice(0, Infinity).forEach(dispose => dispose())
      if (this.plugin) this.stop()
      return this
    }

    start() {
      this.schema = this.plugin['Config'] || this.plugin['schema']
      this.using = this.plugin['using'] || []
      this.registry.app.emit('plugin-added', this)
      this.registry.app.emit('logger/debug', 'app', 'plugin:', this.plugin.name)

      if (this.plugin['reusable']) {
        this.forkers.push(this.apply)
      }

      if (this.using.length) {
        this.context.on('service', (name) => {
          if (!this.using.includes(name)) return
          this.disposables = this.disposables.filter((dispose, index) => {
            // the first element is the "service" event listener
            if (!index || dispose[kState]) return true
            dispose()
          })
          this.callback()
        })
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
