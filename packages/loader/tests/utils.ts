import { Dict } from 'cosmokit'
import { Context, Fiber, Component } from 'cordis'
import { EntryChange, EntryOptions, Group, Loader } from '../src/index.ts'
import { Mock, mock } from 'node:test'
import { expect } from 'vitest'

declare module '../src/index.ts' {
  interface Loader {
    mock<F extends Function>(name: string, component: F): Mock<F>
    expectEnable(component: any, config?: any): void
    expectDisable(component: any): void
    expectFiber(id: string): Fiber
  }
}

export default class MockLoader extends Loader {
  public data: EntryOptions[] = []
  public changes: EntryChange[] = []
  public modules: Dict<Component.Object> = Object.create(null)

  constructor(ctx: Context) {
    super(ctx)
    ctx.on('internal/get', (ctx, prop, error, next) => {
      if (!ctx.fiber.runtime && prop === 'loader') {
        return ctx.get(prop)
      }
      return next()
    })
  }

  commit(change: EntryChange) {
    this.data = this.root.data
    this.changes.push(change)
  }

  async read(data: any) {
    this.data = data
    await this.root.update(data)
    await this.await()
  }

  async import(name: string) {
    if (name === '@cordisjs/group') {
      return Group
    }
    return this.modules[name]
  }

  mock<F extends Function>(name: string, component: F) {
    if (!component.name) {
      Object.defineProperty(component, 'name', { value: name })
    }
    return this.modules[name] = mock.fn(component)
  }

  expectEnable(component: any) {
    const runtime = this.ctx.registry.get(component)
    expect(runtime).to.be.ok
  }

  expectDisable(component: any) {
    const runtime = this.ctx.registry.get(component)
    expect(runtime).to.be.not.ok
  }

  expectFiber(id: string) {
    expect(this.store[id]?.innerFiber).to.be.ok
    return this.store[id]!.innerFiber!
  }
}

export function sleep(ms = 0) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
