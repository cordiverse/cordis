import { defineProperty, remove } from 'cosmokit'
import { Context } from './context'
import { Plugin, Registry } from './plugin'

export type Disposable = () => void

function isConstructor(func: Function): func is new (...args: any) => any {
  // async function or arrow function
  if (!func.prototype) return false
  // generator function or malformed definition
  if (func.prototype.constructor !== func) return false
  return true
}

export abstract class State {
  uid: number
  runtime: Runtime
  context: Context
  disposables: Disposable[] = []

  abstract dispose(): boolean
  abstract restart(): void
  abstract update(config: any): void

  constructor(public parent: Context, public config: any) {
    this.uid = parent.registry ? parent.registry.counter : 0
    this.context = parent.extend({ state: this })
  }

  collect(label: string, callback: () => boolean) {
    const dispose = () => {
      remove(this.disposables, dispose)
      return callback()
    }
    this.disposables.push(dispose)
    defineProperty(dispose, 'name', label)
    return dispose
  }

  protected init() {
    if (this.runtime.using.length) {
      const dispose = this.context.on('internal/service', (name) => {
        if (!this.runtime.using.includes(name)) return
        this.restart()
      })
      defineProperty(dispose, Context.static, true)
    }
  }

  protected check() {
    return this.runtime.using.every(name => this.context[name])
  }

  clear(preserve = false) {
    this.disposables = this.disposables.splice(0, Infinity).filter((dispose) => {
      if (preserve && dispose[Context.static]) return true
      dispose()
    })
  }
}

export class Fork extends State {
  dispose: () => boolean

  constructor(parent: Context, config: any, public runtime: Runtime) {
    super(parent, config)

    this.dispose = parent.state.collect(`fork <${parent.state.runtime.name}>`, () => {
      this.uid = null
      this.clear()
      const result = remove(runtime.disposables, this.dispose)
      if (remove(runtime.children, this) && !runtime.children.length) {
        runtime.dispose()
      }
      parent.emit('internal/fork', this)
      return result
    })

    defineProperty(this.dispose, Context.static, true)
    runtime.children.push(this)
    runtime.disposables.push(this.dispose)
    parent.emit('internal/fork', this)
    if (runtime.isReusable) this.init()
    this.restart()
  }

  restart() {
    this.clear(true)
    if (!this.check()) return
    for (const fork of this.runtime.forkables) {
      fork(this.context, this.config)
    }
  }

  update(config: any) {
    const oldConfig = this.config
    const resolved = Registry.validate(this.runtime.plugin, config)
    this.config = resolved
    this.context.emit('internal/update', this, config)
    if (this.runtime.isForkable) {
      this.restart()
    } else if (this.runtime.config === oldConfig) {
      this.runtime.config = resolved
      this.runtime.restart()
    }
  }
}

export class Runtime extends State {
  runtime = this
  schema: any
  using: readonly string[] = []
  forkables: Function[] = []
  children: Fork[] = []
  isReusable: boolean

  constructor(private registry: Registry, public plugin: Plugin, config: any) {
    super(registry[Context.current], config)
    registry.set(plugin, this)
    if (plugin) this.init()
  }

  get isForkable() {
    return this.forkables.length > 0
  }

  get name() {
    if (!this.plugin) return 'root'
    const { name } = this.plugin
    return !name || name === 'apply' ? 'anonymous' : name
  }

  fork(parent: Context, config: any) {
    return new Fork(parent, config, this)
  }

  dispose() {
    this.uid = null
    this.clear()
    if (this.plugin) {
      const result = this.registry.delete(this.plugin)
      this.context.emit('internal/runtime', this)
      return result
    }
  }

  init() {
    this.schema = this.plugin['Config'] || this.plugin['schema']
    this.using = this.plugin['using'] || []
    this.isReusable = this.plugin['reusable']
    this.context.emit('internal/runtime', this)

    if (this.isReusable) {
      this.forkables.push(this.apply)
    } else {
      super.init()
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
    this.clear(true)
    if (!this.check()) return

    // execute plugin body
    if (!this.isReusable) {
      this.apply(this.context, this.config)
    }

    for (const fork of this.children) {
      fork.restart()
    }
  }

  update(config: any) {
    if (this.isForkable) {
      this.context.emit('internal/warning', `attempting to update forkable plugin "${this.plugin.name}", which may lead to unexpected behavior`)
    }
    const oldConfig = this.config
    const resolved = Registry.validate(this.runtime.plugin, config)
    this.config = resolved
    for (const fork of this.children) {
      if (fork.config !== oldConfig) continue
      fork.config = resolved
      this.context.emit('internal/update', fork, config)
    }
    this.restart()
  }
}
