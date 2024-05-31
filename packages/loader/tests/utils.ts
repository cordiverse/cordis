import { Dict } from 'cosmokit'
import { Context, ForkScope, Plugin } from '@cordisjs/core'
import { EntryOptions, Group, Loader, LoaderFile } from '../src'
import { Mock, mock } from 'node:test'
import { expect } from 'chai'

declare module '../src/index.ts' {
  interface Loader {
    mock<F extends Function>(name: string, plugin: F): Mock<F>
    expectEnable(plugin: any, config?: any): void
    expectDisable(plugin: any): void
    expectFork(id: string): ForkScope
  }
}

class MockLoaderFile extends LoaderFile {
  data: EntryOptions[] = []

  async read() {
    return this.data
  }

  write(data: EntryOptions[]) {
    this.data = data
  }
}

export default class MockLoader extends Loader {
  public file: MockLoaderFile
  public modules: Dict<Plugin.Object> = Object.create(null)

  constructor(ctx: Context) {
    super(ctx, { name: 'cordis' })
    this.file = new MockLoaderFile(this, 'config-1.yml')
    this.file.ref(this)
    this.mock('cordis/group', Group)
  }

  async start() {
    await this.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  async import(name: string) {
    return this.modules[name]
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
    expect(this.store[id]?.fork).to.be.ok
    return this.store[id]!.fork!
  }
}
