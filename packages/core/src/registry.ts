import { defineProperty, Dict } from 'cosmokit'
import { StandardSchemaV1 } from '@standard-schema/spec'
import { Context } from './context'
import { Fiber } from './fiber'
import { buildOuterStack, DisposableList, symbols, withProps } from './utils'

function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }

export type InjectKey = keyof {
  [K in keyof Context & string as Context[K] extends { [symbols.config]: any } ? K : never]: any
}

export function Inject<K extends InjectKey>(name: K, config?: Context[K] extends { [symbols.config]: infer T } ? T : never) {
  return function (value: any, decorator: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) {
    if (decorator.kind === 'class') {
      if (!Object.hasOwn(value, 'inject')) {
        defineProperty(value, 'inject', Object.create(Object.getPrototypeOf(value).inject ?? null))
        defineProperty(value.inject, symbols.checkProto, true)
      }
      value.inject[name] = config
    } else if (decorator.kind === 'method') {
      const inject = (value[symbols.metadata] ??= {}).inject ??= Object.create(null)
      inject[name] = config
      decorator.addInitializer(function () {
        const property = this[symbols.tracker]?.property
        ;(this[symbols.initHooks] ??= []).push(() => {
          (this.ctx as Context).inject(inject, (ctx) => {
            return value.call(property ? withProps(this, { [property]: ctx }) : this)
          })
        })
      })
    } else {
      throw new Error('@Inject() can only be used on class or class methods')
    }
  }
}

export namespace Inject {
  export function resolve(inject: Inject | null | undefined, result: Dict = Object.create(null)) {
    if (!inject) return result
    if (Array.isArray(inject)) {
      for (const name of inject) {
        result[name] = null
      }
    } else if (Reflect.has(inject, symbols.checkProto)) {
      Object.assign(result, resolve(Object.getPrototypeOf(inject)))
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    } else {
      for (const name of Object.keys(inject)) {
        result[name] = inject[name] ?? null
      }
    }
    return result
  }
}

export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>

export namespace Plugin {
  export interface Base<T = any> {
    name?: string
    Config?: StandardSchemaV1<any, T>
    inject?: Inject
    /** Services that every successful fiber of this plugin guarantees to provide. */
    provide?: string | string[]
    intercept?: Dict<boolean>
  }

  export interface Transform<S, T> {
    schema?: true
    Config: (config: S) => T
  }

  export interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): any
  }

  export interface Constructor<T = any> extends Base<T> {
    new (ctx: Context, config: T): any
  }

  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }

  export interface Runtime {
    name?: string
    fibers: DisposableList<Fiber>
    callback: globalThis.Function
    Config?: StandardSchemaV1
  }

  export interface Meta {
    inject: Dict<any>
    provide: string[]
  }

  export interface Candidate {
    callback: globalThis.Function
    parent: Context
    meta: Meta
    replace?: Fiber
    name: string
  }
}

declare module './events' {
  export interface Events {
    'internal/plugin-meta'(meta: Plugin.Meta): void
  }
}

interface DependencyNode {
  id: object
  name: string
  parent: Context
  inject: string[]
  provide: string[]
}

interface ResolvedDependencyNode {
  id: object
  name: string
  inject: Map<symbol, string>
  provide: Map<symbol, string>
}

export class CircularDependencyError extends Error {
  name = 'CircularDependencyError'

  constructor(public cycle: string[]) {
    super(`circular plugin dependency: ${cycle.join(' -> ')}`)
  }
}

class DependencyGraph {
  private nodes = new Map<Fiber, DependencyNode>()
  private dynamic = new Map<Fiber, Set<{ ctx: Context, name: string }>>()

  constructor(private registry: RegistryService) {}

  private resolveToken(ctx: Context, name: string) {
    ctx.root[Context.isolate][name] ??= Symbol(name)
    return ctx[Context.isolate][name]
  }

  private createNode(candidate: Plugin.Candidate): DependencyNode {
    return {
      id: candidate,
      name: candidate.name,
      parent: candidate.parent,
      inject: Object.keys(candidate.meta.inject),
      provide: candidate.meta.provide,
    }
  }

  private resolveNode(node: DependencyNode): ResolvedDependencyNode {
    const inject = new Map<symbol, string>()
    const provide = new Map<symbol, string>()
    for (const name of node.inject) {
      inject.set(this.resolveToken(node.parent, name), name)
    }
    for (const name of node.provide) {
      provide.set(this.resolveToken(node.parent, name), name)
    }
    return { id: node.id, name: node.name, inject, provide }
  }

  private collectNodes(candidates: Plugin.Candidate[]) {
    const replacements = new Set(candidates.map(candidate => candidate.replace).filter(Boolean))
    const nodes = [...this.nodes]
      .filter(([fiber]) => !replacements.has(fiber))
      .map(([fiber, node]) => {
        const resolved = this.resolveNode(node)
        for (const entry of this.dynamic.get(fiber) ?? []) {
          resolved.provide.set(this.resolveToken(entry.ctx, entry.name), entry.name)
        }
        return resolved
      })
    for (const [fiber, dynamic] of this.dynamic) {
      if (this.nodes.has(fiber) || replacements.has(fiber)) continue
      const provide = new Map<symbol, string>()
      for (const entry of dynamic) {
        provide.set(this.resolveToken(entry.ctx, entry.name), entry.name)
      }
      nodes.push({
        id: fiber,
        name: fiber.name,
        inject: new Map(),
        provide,
      })
    }
    nodes.push(...candidates.map(candidate => this.resolveNode(this.createNode(candidate))))
    return nodes
  }

  validate(candidates: Plugin.Candidate[]) {
    const nodes = this.collectNodes(candidates)
    const providers = new Map<symbol, ResolvedDependencyNode>()
    for (const node of nodes) {
      for (const [token, name] of node.provide) {
        const oldNode = providers.get(token)
        if (oldNode && oldNode.id !== node.id) {
          throw new Error(`service "${name}" is provided by both <${oldNode.name}> and <${node.name}>`)
        }
        providers.set(token, node)
      }
    }

    const edges = new Map<ResolvedDependencyNode, ResolvedDependencyNode[]>()
    for (const node of nodes) {
      const targets: ResolvedDependencyNode[] = []
      for (const token of node.inject.keys()) {
        const target = providers.get(token)
        if (target) targets.push(target)
      }
      edges.set(node, targets)
    }

    const visited = new Set<ResolvedDependencyNode>()
    const visiting = new Map<ResolvedDependencyNode, number>()
    const stack: ResolvedDependencyNode[] = []
    const visit = (node: ResolvedDependencyNode): void => {
      if (visited.has(node)) return
      const index = visiting.get(node)
      if (index !== undefined) {
        throw new CircularDependencyError([...stack.slice(index), node].map(node => node.name))
      }
      visiting.set(node, stack.length)
      stack.push(node)
      for (const target of edges.get(node) ?? []) visit(target)
      stack.pop()
      visiting.delete(node)
      visited.add(node)
    }
    for (const node of nodes) visit(node)
  }

  add(fiber: Fiber, candidate: Plugin.Candidate) {
    const node = this.createNode(candidate)
    node.id = fiber
    this.nodes.set(fiber, node)
  }

  delete(fiber: Fiber) {
    this.nodes.delete(fiber)
    this.dynamic.delete(fiber)
  }

  provide(fiber: Fiber, ctx: Context, name: string) {
    const entry = { ctx, name }
    const dynamic = this.dynamic.get(fiber) ?? new Set<{ ctx: Context, name: string }>()
    dynamic.add(entry)
    this.dynamic.set(fiber, dynamic)
    try {
      this.validate([])
    } catch (error) {
      dynamic.delete(entry)
      if (!dynamic.size) this.dynamic.delete(fiber)
      throw error
    }
    return () => {
      dynamic.delete(entry)
      if (!dynamic.size) this.dynamic.delete(fiber)
    }
  }

  assertProvides(fiber: Fiber) {
    const node = this.nodes.get(fiber)
    if (!node) return
    for (const name of node.provide) {
      const token = this.resolveToken(node.parent, name)
      if (this.registry.ctx.reflect.store[token]?.fiber === fiber) continue
      throw new Error(`plugin <${node.name}> declared service "${name}" but did not provide it`)
    }
  }
}

type Spread<T> = undefined extends T ? [config?: T] : [config: T]

type GetPluginParameters<P> =
  | P extends (ctx: Context, ...args: infer R) => any
  ? R
  : P extends new (ctx: Context, ...args: infer R) => any
  ? R
  : P extends { apply(ctx: Context, ...args: infer R): any }
  ? R
  : never

type GetPluginConfig<P> =
  | P extends Plugin.Transform<infer S, any>
  ? S
  : GetPluginParameters<P>[0]

declare module './context' {
  export interface Context {
    inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
    plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>
  }
}

export class RegistryService {
  private _counter = 0
  private _internal = new Map<Function, Plugin.Runtime>()
  private _graph = new DependencyGraph(this)

  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })
  }

  get counter() {
    return ++this._counter
  }

  get size() {
    return this._internal.size
  }

  resolve(plugin: Plugin): Function | undefined {
    // plugin.apply may throw
    try {
      if (typeof plugin === 'function') return plugin
      if (isApplicable(plugin)) return plugin.apply
    } catch {}
  }

  get(plugin: Plugin) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  has(plugin: Plugin) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    for (const fiber of runtime.fibers) {
      fiber.dispose()
    }
    return runtime
  }

  keys() {
    return this._internal.keys()
  }

  values() {
    return this._internal.values()
  }

  entries() {
    return this._internal.entries()
  }

  forEach(callback: (value: Plugin.Runtime, key: Function) => void) {
    return this._internal.forEach(callback)
  }

  inject(inject: Inject, callback: Plugin.Function<void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  prepare(plugin: Plugin, replace?: Fiber): Plugin.Candidate {
    const callback = this.resolve(plugin)
    if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
    this.ctx.fiber.assertActive()

    let name = plugin.name
    if (name === 'apply') name = undefined
    const provide = Array.isArray(plugin.provide)
      ? [...plugin.provide]
      : plugin.provide ? [plugin.provide] : []
    const meta: Plugin.Meta = {
      inject: Inject.resolve(plugin.inject),
      provide,
    }
    this.ctx.emit(this.ctx, 'internal/plugin-meta', meta)
    return {
      callback,
      parent: this.ctx,
      meta,
      replace,
      name: name || callback.name || 'anonymous',
    }
  }

  validate(candidates: Plugin.Candidate[]) {
    this._graph.validate(candidates)
  }

  assertProvides(fiber: Fiber) {
    this._graph.assertProvides(fiber)
  }

  _release(fiber: Fiber) {
    this._graph.delete(fiber)
  }

  _provide(fiber: Fiber, name: string) {
    return this._graph.provide(fiber, this.ctx, name)
  }

  plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
    const candidate = this.prepare(plugin)
    this.validate([candidate])
    const { callback } = candidate

    let runtime = this._internal.get(callback)
    if (!runtime) {
      const name = candidate.name === 'anonymous' ? undefined : candidate.name
      runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
      this._internal.set(callback, runtime)
    }

    const fiber = new Fiber(this.ctx, config, candidate.meta.inject, runtime, getOuterStack)
    this._graph.add(fiber, candidate)
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
    wrapped.then = (onFulfilled, onRejected) => {
      return fiber.await().then(onFulfilled, onRejected)
    }
    return wrapped
  }
}
