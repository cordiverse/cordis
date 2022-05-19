import { Awaitable } from 'cosmokit'
import { App } from './app'
import { Context } from './context'
import { Lifecycle } from './lifecycle'
import { Plugin, Registry } from './plugin'

export * from './app'
export * from './context'
export * from './lifecycle'
export * from './plugin'

export interface Events {
  'logger/error'(name: string, ...param: any[]): void
  'logger/success'(name: string, ...param: any[]): void
  'logger/warn'(name: string, ...param: any[]): void
  'logger/info'(name: string, ...param: any[]): void
  'logger/debug'(name: string, ...param: any[]): void
  'plugin-added'(state: Plugin.State): void
  'plugin-removed'(state: Plugin.State): void
  'ready'(): Awaitable<void>
  'dispose'(): Awaitable<void>
  'service'(name: string, oldValue: any): void
}

export interface Services extends Context.Services {
  app: App
  lifecycle: Lifecycle
  registry: Registry
}

export interface Session {}
