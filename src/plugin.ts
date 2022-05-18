import { Context } from './context'
import Schema from 'schemastery'

export type Disposable = () => void

export type Plugin = Plugin.Function | Plugin.Object

export namespace Plugin {
  export type Function<T = any> = (ctx: Context, options: T) => void
  export type Constructor<T = any> = new (ctx: Context, options: T) => void

  export interface Object<T = any> {
    name?: string
    apply: Function<T>
    Config?: Schema
    using?: readonly string[]
  }

  export interface ObjectWithSchema<T = any> {
    name?: string
    apply: Function
    schema?: Schema<T, any>
    using?: readonly string[]
  }

  export type Config<T extends Plugin> =
    | T extends Constructor<infer U> ? U
    : T extends Function<infer U> ? U
    : T extends ObjectWithSchema<infer U> ? U
    : T extends Object<infer U> ? U
    : never

  export interface State {
    id: string
    parent: Context
    context?: Context
    config?: any
    using: readonly string[]
    schema?: Schema
    plugin?: Plugin
    children: Plugin[]
    disposables: Disposable[]
  }
}

export class Registry extends Map<Plugin, Plugin.State> {
  constructor() {
    super()
    this.set(null, {
      id: '',
      parent: null,
      using: [],
      children: [],
      disposables: [],
    })
  }

  private resolve(plugin: Plugin) {
    return plugin && (typeof plugin === 'function' ? plugin : plugin.apply)
  }

  get(plugin: Plugin) {
    return super.get(this.resolve(plugin))
  }

  set(plugin: Plugin, state: Plugin.State) {
    return super.set(this.resolve(plugin), state)
  }

  has(plugin: Plugin) {
    return super.has(this.resolve(plugin))
  }

  delete(plugin: Plugin) {
    return super.delete(this.resolve(plugin))
  }
}
