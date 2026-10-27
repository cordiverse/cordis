import { expect, describe, it } from 'vitest'
import { Context, FiberState } from 'cordis'
import { setImmediate } from 'node:timers/promises'
import MockLoader from './utils.ts'

async function boot(plugins: Record<string, (ctx: Context) => void>) {
  const root = new Context()
  await root.plugin(MockLoader)
  const loader = root.loader as MockLoader
  for (const [name, plugin] of Object.entries(plugins)) loader.mock(name, plugin)
  return { root, loader }
}

describe('Service Isolation: empty label', () => {
  it('starts every entry that isolates a service under the empty label', async () => {
    const { loader } = await boot({
      foo: (ctx) => { ctx.provide('foo') },
      bar: (ctx) => { ctx.provide('bar') },
    })

    const foo = await loader.create({ name: 'foo', isolate: { foo: '' } })
    const bar = await loader.create({ name: 'bar', isolate: { bar: '' } })
    await setImmediate()

    expect(loader.store[foo].innerFiber?.state).to.equal(FiberState.ACTIVE)
    expect(loader.store[bar].innerFiber?.state).to.equal(FiberState.ACTIVE)
  })
})
