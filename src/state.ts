import { deepEqual, defineProperty, remove } from 'cosmokit'
import { Context } from './context'
import { Plugin, Registry } from './registry'
import { getConstructor, isConstructor, resolveConfig } from './utils'

declare module './context' {
  export interface Context {
    state: State<this>
    runtime: Runtime<this>
    collect(label: string, callback: () => boolean): () => boolean
    accept(callback?: (config: any) => void | boolean, options?: AcceptOptions): () => boolean
    accept(keys: string[], callback?: (config: any) => void | boolean, options?: AcceptOptions): () => boolean
    decline(keys: string[]): () => boolean
  }
}

export type Disposable = () => void

export interface AcceptOptions {
  passive?: boolean
}

export interface Acceptor extends AcceptOptions {
  keys?: string[]
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
  abstract start(): void
  abstract update(config: any): void

  constructor(public parent: C, public config: any) {
    this.uid = parent.registry ? parent.registry.counter : 0
    this.ctx = this.context = parent.extend({ state: this })
  }

  collect(label: string, callback: () => boolean) {
    const dispose = defineProperty(() => {
      remove(this.disposables, dispose)
      return callback()
    }, 'name', label)
    this.disposables.push(dispose)
    return dispose
  }

  restart() {
    this.clear(true)
    this.start()
  }

  protected setup() {
    if (!this.runtime.using.length) return
    defineProperty(this.context.on('internal/before-service', (name) => {
      if (!this.runtime.using.includes(name)) return
      this.clear(true)
    }), Context.static, this)
    defineProperty(this.context.on('internal/service', (name) => {
      if (!this.runtime.using.includes(name)) return
      this.start()
    }), Context.static, this)
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

  accept(callback?: (config: any) => void | boolean, options?: AcceptOptions): () => boolean
  accept(keys: string[], callback?: (config: any) => void | boolean, options?: AcceptOptions): () => boolean
  accept(...args: any[]) {
    const keys = Array.isArray(args[0]) ? args.shift() : null
    const acceptor: Acceptor = { keys, callback: args[0], ...args[1] }
    this.acceptors.push(acceptor)
    return this.collect(`accept <${keys?.join(', ') || '*'}>`, () => remove(this.acceptors, acceptor))
  }

  decline(keys: string[]) {
    return this.accept(keys, () => true)
  }

  checkUpdate(resolved: any) {
    const modified: Record<string, boolean> = Object.create(null)
    const checkPropertyUpdate = (key: string) => {
      const result = modified[key] ??= !deepEqual(this.config[key], resolved[key])
      hasUpdate ||= result
      return result
    }

    const ignored = new Set<string>()
    let hasUpdate = false, shouldRestart = false
    let fallback: boolean | null = null
    for (const { keys, callback, passive } of this.acceptors) {
      if (!keys) {
        fallback ||= !passive
      } else if (passive) {
        keys?.forEach(key => ignored.add(key))
      } else {
        let hasUpdate = false
        for (const key of keys) {
          hasUpdate ||= checkPropertyUpdate(key)
        }
        if (!hasUpdate) continue
      }
      const result = callback?.(resolved)
      if (result) shouldRestart = true
    }

    for (const key in { ...this.config, ...resolved }) {
      if (fallback === false) continue
      if (!(key in modified) && !ignored.has(key)) {
        const hasUpdate = checkPropertyUpdate(key)
        if (fallback === null) shouldRestart ||= hasUpdate
      }
    }
    return [hasUpdate, shouldRestart]
  }
}

export class Fork<C extends Context = Context> extends State<C> {
  dispose: () => boolean

  constructor(parent: Context, config: any, public runtime: Runtime<C>) {
    super(parent as C, config)

    this.dispose = defineProperty(parent.state.collect(`fork <${parent.runtime.name}>`, () => {
      this.uid = null
      this.clear()
      const result = remove(runtime.disposables, this.dispose)
      if (remove(runtime.children, this) && !runtime.children.length) {
        parent.registry.delete(runtime.plugin)
      }
      this.context.emit('internal/fork', this)
      return result
    }), Context.static, runtime)

    runtime.children.push(this)
    runtime.disposables.push(this.dispose)
    this.context.emit('internal/fork', this)
    if (runtime.isReusable) {
      // non-reusable plugin forks are not responsive to isolated service changes
      this.setup()
    }
    this.start()
  }

  start() {
    if (!this.check()) return
    for (const fork of this.runtime.forkables) {
      fork(this.context, this.config)
    }
  }

  update(config: any) {
    const oldConfig = this.config
    const state: State<C> = this.runtime.isForkable ? this : this.runtime
    if (state.config !== oldConfig) return
    const resolved = resolveConfig(this.runtime.plugin, config)
    const [hasUpdate, shouldRestart] = state.checkUpdate(resolved)
    this.config = resolved
    state.config = resolved
    if (hasUpdate) {
      this.context.emit('internal/update', this, config)
    }
    if (shouldRestart) state.restart()
  }
}

export class Runtime<C extends Context = Context> extends State<C> {
  runtime = this
  schema: any
  using: readonly string[] = []
  forkables: Function[] = []
  children: Fork<C>[] = []
  isReusable = false

  constructor(registry: Registry<C>, public plugin: Plugin, config: any) {
    super(registry[Context.current] as C, config)
    registry.set(plugin, this)
    if (plugin) this.setup()
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

  setup() {
    this.schema = this.plugin['Config'] || this.plugin['schema']
    this.using = this.plugin['using'] || []
    this.isReusable = this.plugin['reusable']
    this.context.emit('internal/runtime', this)

    if (this.isReusable) {
      this.forkables.push(this.apply)
    } else {
      super.setup()
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

  clear(preserve?: boolean) {
    super.clear(preserve)
    for (const fork of this.children) {
      fork.clear(preserve)
    }
  }

  start() {
    if (!this.check()) return

    // execute plugin body
    if (!this.isReusable && this.plugin) {
      this.apply(this.context, this.config)
    }

    for (const fork of this.children) {
      fork.start()
    }
  }

  update(config: any) {
    if (this.isForkable) {
      this.context.emit('internal/warning', `attempting to update forkable plugin "${this.plugin.name}", which may lead to unexpected behavior`)
    }
    const oldConfig = this.config
    const resolved = resolveConfig(this.runtime.plugin || getConstructor(this.context), config)
    const [hasUpdate, shouldRestart] = this.checkUpdate(resolved)
    this.config = resolved
    for (const fork of this.children) {
      if (fork.config !== oldConfig) continue
      fork.config = resolved
      if (hasUpdate) {
        this.context.emit('internal/update', fork, config)
      }
    }
    if (shouldRestart) this.restart()
  }
}
