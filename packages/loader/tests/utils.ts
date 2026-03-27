import { Dict } from 'cosmokit'
import { Context, Fiber, Plugin } from 'cordis'
import { EntryOptions, Group, Loader } from '../src'
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

export default class MockLoader<C extends Context = Context> extends Loader<C> {
  public data: EntryOptions[] = []
  public modules: Dict<Plugin.Object> = Object.create(null)

  constructor(ctx: C) {
    super(ctx)
    ctx.on('internal/get', (ctx, prop, error, next) => {
      if (!ctx.fiber.runtime && prop === 'loader') {
        return ctx.get(prop)
      }
      return next()
    })
  }

  write() {
    this.data = this.root.data
  }

  async read(data: any) {
    this.data = data
    await this.root.update(data)
    await this.await()
  }

  async import(name: string) {
    if (name === '@cordisjs/plugin-group') {
      return Group
    }
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

export function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
