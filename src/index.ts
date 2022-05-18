import { Awaitable } from 'cosmokit'
import { Lifecycle } from './lifecycle'
import { Plugin, Registry } from './plugin'

export * from './context'
export * from './lifecycle'
export * from './plugin'

export interface Events {
  'plugin-added'(state: Plugin.State): void
  'plugin-removed'(state: Plugin.State): void
  'ready'(): Awaitable<void>
  'dispose'(): Awaitable<void>
  'service'(name: string): void
}

export interface Services {
  lifecycle: Lifecycle
  registry: Registry
  services: Services
}

export interface Session {}
