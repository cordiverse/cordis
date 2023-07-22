import { deepEqual, defineProperty, remove } from 'cosmokit'
import { Context } from './context'
import { Plugin, Registry } from './registry'
import { getConstructor, isConstructor, resolveConfig } from './utils'

declare module './context' {
  export interface Context {
    scope: EffectScope<this>
    runtime: MainScope<this>
    collect(label: string, callback: () => boolean): () => boolean
    accept(callback?: (config: this['config']) => void | boolean, options?: AcceptOptions): () => boolean
    accept(keys: (keyof this['config'])[], callback?: (config: this['config']) => void | boolean, options?: AcceptOptions): () => boolean
    decline(keys: (keyof this['config'])[]): () => boolean
  }
}

export type Disposable = () => void

export interface AcceptOptions {
  passive?: boolean
  immediate?: boolean
}

export interface Acceptor extends AcceptOptions {
  keys?: string[]
  callback?: (config: any) => void | boolean
}

export type ScopeStatus = 'pending' | 'loading' | 'active' | 'failed' | 'disposed'

export abstract class EffectScope<C extends Context = Context> {
  public uid: number | null
  public ctx: C
  public disposables: Disposable[] = []
  public error: any
  public status: ScopeStatus = 'pending'

  protected proxy: any
  protected context: Context
  protected acceptors: Acceptor[] = []
  protected tasks = new Set<Promise<void>>()
  protected hasError = false
  protected isActive = false

  abstract runtime: MainScope<C>
  abstract dispose(): boolean
  abstract update(config: C['config'], forced?: boolean): void

  constructor(public parent: C, public config: C['config']) {
    this.uid = parent.registry ? parent.registry.counter : 0
    this.ctx = this.context = parent.extend({ scope: this })
    this.proxy = new Proxy({}, {
      get: (target, key) => Reflect.get(this.config, key),
    })
  }

  protected get _config() {
    return this.runtime.isReactive ? this.proxy : this.config
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
    this.reset()
    this.start()
  }

  protected _getStatus() {
    if (this.uid === null) return 'disposed'
    if (this.hasError) return 'failed'
    if (this.tasks.size) return 'loading'
    if (this.ready) return 'active'
    return 'pending'
  }

  protected _updateStatus(callback?: () => void) {
    const oldValue = this.status
    callback?.()
    this.status = this._getStatus()
    if (oldValue !== this.status) {
      this.context.emit('internal/status', this, oldValue)
    }
  }

  ensure(callback: () => Promise<void>) {
    const task = callback()
      .catch((reason) => {
        this.context.emit('internal/warning', reason)
        this.cancel(reason)
      })
      .finally(() => {
        this._updateStatus(() => this.tasks.delete(task))
        this.context.events._tasks.delete(task)
      })
    this._updateStatus(() => this.tasks.add(task))
    this.context.events._tasks.add(task)
  }

  cancel(reason: any) {
    this.error = reason
    this._updateStatus(() => this.hasError = true)
    this.reset()
  }

  protected setup() {
    if (!this.runtime.using.length) return
    defineProperty(this.context.on('internal/before-service', (name) => {
      if (!this.runtime.using.includes(name)) return
      this._updateStatus()
      this.reset()
    }), Context.static, this)
    defineProperty(this.context.on('internal/service', (name) => {
      if (!this.runtime.using.includes(name)) return
      this.start()
    }), Context.static, this)
  }

  get ready() {
    return this.runtime.using.every(name => this.ctx[name])
  }

  reset() {
    this.isActive = false
    this.disposables = this.disposables.splice(0).filter((dispose) => {
      if (this.uid !== null && dispose[Context.static] === this) return true
      dispose()
    })
  }

  start() {
    if (!this.ready || this.isActive || this.uid === null) return true
    this.isActive = true
    this._updateStatus(() => this.hasError = false)
  }

  accept(callback?: (config: C['config']) => void | boolean, options?: AcceptOptions): () => boolean
  accept(keys: string[], callback?: (config: C['config']) => void | boolean, options?: AcceptOptions): () => boolean
  accept(...args: any[]) {
    const keys = Array.isArray(args[0]) ? args.shift() : null
    const acceptor: Acceptor = { keys, callback: args[0], ...args[1] }
    this.acceptors.push(acceptor)
    if (acceptor.immediate) acceptor.callback?.(this.config)
    return this.collect(`accept <${keys?.join(', ') || '*'}>`, () => remove(this.acceptors, acceptor))
  }

  decline(keys: string[]) {
    return this.accept(keys, () => true)
  }

  checkUpdate(resolved: any, forced?: boolean) {
    if (forced) return [true, true]
    if (forced === false) return [false, false]

    const modified: Record<string, boolean> = Object.create(null)
    const checkPropertyUpdate = (key: string) => {
      const result = modified[key] ??= !deepEqual(this.config[key], resolved[key])
      hasUpdate ||= result
      return result
    }

    const ignored = new Set<string>()
    let hasUpdate = false, shouldRestart = false
    let fallback: boolean | null = this.runtime.isReactive || null
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

export class ForkScope<C extends Context = Context> extends EffectScope<C> {
  dispose: () => boolean

  constructor(parent: Context, config: C['config'], public runtime: MainScope<C>) {
    super(parent as C, config)

    this.dispose = defineProperty(parent.scope.collect(`fork <${parent.runtime.name}>`, () => {
      this.uid = null
      this.reset()
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
    if (super.start()) return true
    for (const fork of this.runtime.forkables) {
      this.ensure(async () => fork(this.context, this._config))
    }
  }

  update(config: any, forced?: boolean) {
    const oldConfig = this.config
    const state: EffectScope<C> = this.runtime.isForkable ? this : this.runtime
    if (state.config !== oldConfig) return
    const resolved = resolveConfig(this.runtime.plugin, config)
    const [hasUpdate, shouldRestart] = state.checkUpdate(resolved, forced)
    this.context.emit('internal/before-update', this, config)
    this.config = resolved
    state.config = resolved
    if (hasUpdate) {
      this.context.emit('internal/update', this, oldConfig)
    }
    if (shouldRestart) state.restart()
  }
}

export class MainScope<C extends Context = Context> extends EffectScope<C> {
  runtime = this
  schema: any
  using: readonly string[] = []
  forkables: Function[] = []
  children: ForkScope<C>[] = []
  isReusable = false
  isReactive = false

  constructor(registry: Registry<C>, public plugin: Plugin, config: any) {
    super(registry[Context.current] as C, config)
    registry.set(plugin, this)
    if (plugin) {
      this.setup()
    } else {
      this.isActive = true
    }
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
    return new ForkScope(parent, config, this)
  }

  dispose() {
    this.uid = null
    this.reset()
    this.context.emit('internal/runtime', this)
    return true
  }

  setup() {
    this.schema = this.plugin['Config'] || this.plugin['schema']
    this.using = this.plugin['using'] || []
    this.isReusable = this.plugin['reusable']
    this.isReactive = this.plugin['reactive']
    this.context.emit('internal/runtime', this)

    if (this.isReusable) {
      this.forkables.push(this.apply)
    } else {
      super.setup()
    }

    this.restart()
  }

  private apply = (context: Context, config: any) => {
    const plugin = this.plugin
    if (typeof plugin !== 'function') {
      this.ensure(async () => plugin.apply(context, config))
    } else if (isConstructor(plugin)) {
      // eslint-disable-next-line new-cap
      const instance = new plugin(context, config)
      const name = instance[Context.expose]
      if (name) {
        context[name] = instance
      }
      if (instance['fork']) {
        this.forkables.push(instance['fork'].bind(instance))
      }
    } else {
      this.ensure(async () => plugin(context, config))
    }
  }

  reset() {
    super.reset()
    for (const fork of this.children) {
      fork.reset()
    }
  }

  start() {
    if (super.start()) return true
    if (!this.isReusable && this.plugin) {
      this.apply(this.context, this._config)
    }
    for (const fork of this.children) {
      fork.start()
    }
  }

  update(config: C['config'], forced?: boolean) {
    if (this.isForkable) {
      this.context.emit('internal/warning', `attempting to update forkable plugin "${this.plugin.name}", which may lead to unexpected behavior`)
    }
    const oldConfig = this.config
    const resolved = resolveConfig(this.runtime.plugin || getConstructor(this.context), config)
    const [hasUpdate, shouldRestart] = this.checkUpdate(resolved, forced)
    const state = this.children.find(fork => fork.config === oldConfig)
    this.config = resolved
    if (state) {
      this.context.emit('internal/before-update', state, config)
      state.config = resolved
      if (hasUpdate) {
        this.context.emit('internal/update', state, oldConfig)
      }
    }
    if (shouldRestart) this.restart()
  }
}
