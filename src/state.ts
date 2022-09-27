import { deepEqual, defineProperty, intersection, remove } from 'cosmokit'
import { Context } from './context'
import { Plugin, Registry } from './registry'
import { isConstructor, resolveConfig } from './utils'

declare module './context' {
  export interface Context {
    state: State<this>
    runtime: Runtime<this>
    collect(label: string, callback: () => boolean): () => boolean
    accept(keys: string[], callback?: (config: any) => void | boolean): () => boolean
  }
}

export type Disposable = () => void

export interface Acceptor {
  keys: string[]
  callback?: (config: any) => void | boolean
}

export abstract class State<C extends Context = Context> {
  uid: number | null
  ctx: C
  context: Context
  disposables: Disposable[] = []

  protected acceptors: Acceptor[] = []

  abstract runtime: Runtime<C>
  abstract dispose(): boolean
  abstract restart(): void
  abstract update(config: any): void

  constructor(public parent: C, public config: any) {
    this.uid = parent.registry ? parent.registry.counter : 0
    this.ctx = this.context = parent.extend({ state: this })
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
      defineProperty(dispose, Context.static, this)
    }
  }

  protected check() {
    return this.runtime.using.every(name => this.context[name])
  }

  clear(preserve = false) {
    this.disposables = this.disposables.splice(0, Infinity).filter((dispose) => {
      if (preserve && dispose[Context.static] === this) return true
      dispose()
    })
  }

  accept(keys: string[], callback?: (config: any) => void | boolean): () => boolean {
    const acceptor: Acceptor = { keys, callback }
    this.acceptors.push(acceptor)
    return this.collect(`accept <${keys.join(', ')}>`, () => remove(this.acceptors, acceptor))
  }

  diff(resolved: any) {
    const modified = Object
      .keys({ ...this.config, ...resolved })
      .filter(key => !deepEqual(this.config[key], resolved[key]))
    const declined = new Set(modified)
    let shouldUpdate = false
    for (const { keys, callback } of this.acceptors) {
      keys.forEach(key => declined.delete(key))
      if (!intersection(keys, modified).length) continue
      const result = callback?.(resolved)
      if (result) shouldUpdate = true
    }
    return !!declined.size || shouldUpdate
  }
}

export class Fork<C extends Context = Context> extends State<C> {
  dispose: () => boolean

  constructor(parent: Context, config: any, public runtime: Runtime<C>) {
    super(parent as C, config)

    this.dispose = parent.state.collect(`fork <${parent.runtime.name}>`, () => {
      this.uid = null
      this.clear()
      const result = remove(runtime.disposables, this.dispose)
      if (remove(runtime.children, this) && !runtime.children.length) {
        parent.registry.delete(runtime.plugin)
      }
      this.context.emit('internal/fork', this)
      return result
    })

    defineProperty(this.dispose, Context.static, runtime)
    runtime.children.push(this)
    runtime.disposables.push(this.dispose)
    this.context.emit('internal/fork', this)
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
    const resolved = resolveConfig(this.runtime.plugin, config)
    if (this.runtime.isForkable) {
      const shouldUpdate = this.diff(resolved)
      this.config = resolved
      this.context.emit('internal/update', this, config)
      if (shouldUpdate) this.restart()
    } else if (this.runtime.config === oldConfig) {
      const shouldUpdate = this.runtime.diff(resolved)
      this.config = resolved
      this.runtime.config = resolved
      this.context.emit('internal/update', this, config)
      if (shouldUpdate) this.runtime.restart()
    }
  }
}

export class Runtime<C extends Context = Context> extends State<C> {
  runtime = this
  schema: any
  using: readonly string[] = []
  forkables: Function[] = []
  children: Fork<C>[] = []
  isReusable = false

  constructor(private registry: Registry<C>, public plugin: Plugin, config: any) {
    super(registry[Context.current] as C, config)
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
    this.context.emit('internal/runtime', this)
    return true
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
        this.forkables.push(instance['fork'].bind(instance))
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
    const resolved = resolveConfig(this.runtime.plugin, config)
    const shouldUpdate = this.diff(resolved)
    this.config = resolved
    for (const fork of this.children) {
      if (fork.config !== oldConfig) continue
      fork.config = resolved
      this.context.emit('internal/update', fork, config)
    }
    if (shouldUpdate) {
      this.restart()
    }
  }
}
