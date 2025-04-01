import { Dict } from 'cosmokit'
import { Context, Fiber, Plugin } from '@cordisjs/core'
import { EntryOptions, Group, Loader, LoaderFile } from '../src'
import { Mock, mock } from 'node:test'
import { expect } from 'chai'

declare module '../src' {
  interface Loader {
    mock<F extends Function>(name: string, plugin: F): Mock<F>
    expectEnable(plugin: any, config?: any): void
    expectDisable(plugin: any): void
    expectFiber(id: string): Fiber
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

export default class MockLoader<C extends Context = Context> extends Loader<C> {
  declare file: MockLoaderFile

  public modules: Dict<Plugin.Object> = Object.create(null)

  constructor(ctx: C) {
    super(ctx, { name: 'cordis' })
    this.mock('cordis/group', Group)
  }

  async init(baseDir: string, options: Loader.Config) {
    this.file = new MockLoaderFile('config-1.yml')
    this.file.ref(this)
  }

  async read(data: any) {
    this.file.write(data)
    await this.root.update(data)
    await this.wait()
  }

  async import(name: string) {
    return this.modules[name]
  }

  mock<F extends Function>(name: string, plugin: F) {
    if (!plugin.name) {
      Object.defineProperty(plugin, 'name', { value: name })
    }
    return this.modules[name] = mock.fn(plugin)
  }

  expectEnable(plugin: any) {
    const runtime = this.ctx.registry.get(plugin)
    expect(runtime).to.be.ok
  }

  expectDisable(plugin: any) {
    const runtime = this.ctx.registry.get(plugin)
    expect(runtime).to.be.not.ok
  }

  expectFiber(id: string) {
    expect(this.store[id]?.fiber).to.be.ok
    return this.store[id]!.fiber!
  }
}
