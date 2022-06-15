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
    uid: number
    runtime: Runtime
    context: Context
    disposables: Disposable[] = []

    abstract dispose(): boolean
    abstract restart(): void
    abstract update(config: any, manual?: boolean): void

    constructor(public parent: Context, public config: any) {
      this.uid = parent.app.counter++
      this.context = parent.extend({ state: this })
    }

    protected clear(preserve = false) {
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
      this.clear()
      if (!this.runtime.isActive) return
      for (const fork of this.runtime.forkables) {
        fork(this.context, this.config)
      }
    }

    update(config: any, manual = false) {
      const oldConfig = this.config
      const resolved = Registry.validate(this.runtime.plugin, config)
      this.config = resolved
      if (!manual) {
        this.context.emit('internal/update', this, config)
      }
      if (this.runtime.isForkable) {
        this.restart()
      } else if (this.runtime.config === oldConfig) {
        this.runtime.config = resolved
        this.runtime.restart()
      }
    }

    dispose() {
      this.clear()
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
    forkables: Function[] = []
    children: Fork[] = []
    isActive: boolean

    constructor(private registry: Registry, public plugin: Plugin, config: any) {
      super(registry.caller, config)
      registry.set(plugin, this)
      if (plugin) this.init()
    }

    get isForkable() {
      return this.forkables.length > 0
    }

    fork(parent: Context, config: any) {
      return new Fork(parent, config, this)
    }

    dispose() {
      this.clear()
      if (this.plugin) {
        const result = this.registry.delete(this.plugin)
        this.context.emit('plugin-removed', this)
        return result
      }
    }

    init() {
      this.schema = this.plugin['Config'] || this.plugin['schema']
      this.using = this.plugin['using'] || []
      this.context.emit('plugin-added', this)

      if (this.plugin['reusable']) {
        this.forkables.push(this.apply)
      }

      if (this.using.length) {
        const dispose = this.context.on('internal/service', (name) => {
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
        if (instance['fork']) {
          this.forkables.push(instance['fork'])
        }
      } else {
        this.plugin(context, config)
      }
    }

    restart() {
      this.isActive = false
      this.clear(true)
      if (this.using.some(name => !this.context[name])) return

      // execute plugin body
      this.isActive = true
      if (!this.plugin['reusable']) {
        this.apply(this.context, this.config)
      }

      for (const fork of this.children) {
        fork.restart()
      }
    }

    update(config: any, manual = false) {
      if (this.isForkable) {
        this.context.emit('internal/warn', `attempting to update forkable plugin "${this.plugin.name}", which may lead unexpected behavior`)
      }
      const oldConfig = this.config
      const resolved = Registry.validate(this.runtime.plugin, config)
      this.config = resolved
      for (const fork of this.children) {
        if (fork.config !== oldConfig) continue
        fork.config = resolved
        if (!manual) {
          this.context.emit('internal/update', fork, config)
        }
      }
      this.restart()
    }
  }
}
