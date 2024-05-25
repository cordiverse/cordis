import { Dict } from 'cosmokit'
import { Context, ForkScope, Plugin } from '@cordisjs/core'
import { LoaderFile, Entry, group, Loader } from '../src'
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

class MockLoaderFile extends LoaderFile {
  mutable = true
  data: Entry.Options[] = []

  async read() {
    return this.data
  }

  write(data: Entry.Options[]) {
    this.data = data
  }

  async import(name: string) {
    return (this.ctx.loader as MockLoader).modules[name]
  }
}

export default class MockLoader extends Loader {
  declare file: MockLoaderFile
  public modules: Dict<Plugin.Object> = Object.create(null)

  constructor(ctx: Context) {
    super(ctx, { name: 'cordis' })
    this.mock('cordis/group', group)
  }

  async refresh() {
    await super.refresh()
    while (this.tasks.size) {
      await Promise.all(this.tasks)
    }
  }

  async start() {
    this.file = new MockLoaderFile(this.ctx, 'cordis.yml')
    await this.refresh()
  }

  mock<F extends Function>(name: string, plugin: F) {
    return this.modules[name] = mock.fn(plugin)
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
