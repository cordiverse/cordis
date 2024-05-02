import { Dict } from 'cosmokit'
import { Context, ForkScope, Plugin } from '@cordisjs/core'
import { Entry, group, Loader } from '../src'
import { Mock, mock } from 'node:test'
import { expect } from 'chai'

declare module '../src/shared' {
  interface Loader {
    mock<F extends Function>(name: string, plugin: F): Mock<F>
    expectEnable(plugin: any, config?: any): void
    expectDisable(plugin: any): void
    expectFork(id: string): ForkScope
  }
}

export default class MockLoader extends Loader {
  public modules: Dict<Plugin.Object> = Object.create(null)
  public config: Entry.Options[] = []

  constructor(ctx: Context) {
    super(ctx, { name: 'cordis' })
    this.mock('cordis/group', group)
    this.writable = true
  }

  mock<F extends Function>(name: string, plugin: F) {
    return this.modules[name] = mock.fn(plugin)
  }

  async import(name: string) {
    return this.modules[name]
  }

  async readConfig() {
    return this.config
  }

  expectEnable(plugin: any, config?: any) {
    const runtime = this.ctx.registry.get(plugin)
    expect(runtime).to.be.ok
    expect(runtime!.config).to.deep.equal(config)
  }

  expectDisable(plugin: any) {
    const runtime = this.ctx.registry.get(plugin)
    expect(runtime).to.be.not.ok
  }

  expectFork(id: string) {
    expect(this.entries[id]?.fork).to.be.ok
    return this.entries[id]!.fork!
  }
}
