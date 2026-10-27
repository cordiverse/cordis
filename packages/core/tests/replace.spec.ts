import { Context, FiberState, Plugin } from '../src/index.ts'
import { expect, describe, it } from 'vitest'
import { mock } from 'node:test'
import { sleep } from './utils.ts'

describe('registry.replace()', () => {
  it('swaps the implementation behind a fiber in place', async () => {
    const root = new Context()
    const disposeOld = mock.fn()
    const old = mock.fn((ctx: Context, config: any) => () => disposeOld())
    const next = mock.fn()
    const fiber = await root.plugin(old, { foo: 1 })
    const { uid } = fiber

    const replaced = root.registry.replace(old, next)
    await Promise.all(replaced.map(fiber => fiber.await()))

    expect(replaced).to.have.length(1)
    expect(disposeOld.mock.calls).to.have.length(1)
    expect(next.mock.calls).to.have.length(1)
    expect(next.mock.calls[0].arguments[1]).to.deep.equal({ foo: 1 })
    // the reference returned by `ctx.plugin()` stays valid
    expect(fiber.uid).to.equal(uid)
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(fiber.runtime).to.equal(root.registry.get(next))
    expect([...root.registry.keys()]).to.deep.equal([next])
  })

  it('validates the config with the new schema', async () => {
    const root = new Context()
    const schema = (validate: (value: any) => any): any => ({
      '~standard': { version: 1, vendor: 'test', validate: (value: any) => ({ value: validate(value) }) },
    })
    const apply = mock.fn()
    const old = { Config: schema(value => ({ ...value, version: 1 })), apply() {} }
    const next = { Config: schema(value => ({ ...value, version: 2 })), apply }
    await root.plugin(old, { foo: 1 })

    await Promise.all(root.registry.replace(old, next).map(fiber => fiber.await()))
    expect(apply.mock.calls[0].arguments[1]).to.deep.equal({ foo: 1, version: 2 })
  })

  it('takes the dependencies of the new plugin', async () => {
    const root = new Context()
    const replaced = mock.fn()
    root.on('internal/replace', replaced)
    const old = { apply() {} }
    const apply = mock.fn()
    const next = { inject: ['dep'], apply }
    const fiber = await root.plugin(old)

    root.registry.replace(old, next)
    await fiber.await()
    expect(replaced.mock.calls).to.have.length(1)
    expect(replaced.mock.calls[0].arguments[0]).to.equal(fiber)
    expect(Object.keys(fiber.inject)).to.deep.equal(['dep'])
    expect(fiber.state).to.equal(FiberState.PENDING)
    expect(apply.mock.calls).to.have.length(0)

    root.provide('dep', {})
    await fiber.await()
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(apply.mock.calls).to.have.length(1)
  })

  it('starts a pending fiber when the new plugin drops the missing dependency', async () => {
    const root = new Context()
    const old = { inject: ['missing'], apply() {} }
    const next = mock.fn()
    const fiber = await root.plugin(old)
    expect(fiber.state).to.equal(FiberState.PENDING)

    root.registry.replace(old, next)
    await fiber.await()
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(next.mock.calls).to.have.length(1)
  })

  it('starts a pending fiber when the new plugin injects an available service', async () => {
    const root = new Context()
    root.provide('available', {})
    const old = { inject: ['missing'], apply() {} }
    const apply = mock.fn()
    const fiber = await root.plugin(old)
    expect(fiber.state).to.equal(FiberState.PENDING)

    root.registry.replace(old, { inject: ['available'], apply })
    await fiber.await()
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(apply.mock.calls).to.have.length(1)
  })

  it('stops depending on a dependency that the new plugin drops', async () => {
    const root = new Context()
    const provider = await root.plugin(ctx => ctx.provide('dep', {}))
    const old = { inject: ['dep'], apply() {} }
    const next = mock.fn()
    const fiber = await root.plugin(old)

    root.registry.replace(old, next)
    await fiber.await()
    // the provider does not wait for the fiber to unload, nor is the fiber reloaded
    await Promise.race([provider.restart(), sleep(1000).then(() => { throw new Error('not settled') })])
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(next.mock.calls).to.have.length(1)
  })

  it('merges the fibers into a registered plugin', async () => {
    const root = new Context()
    const old = mock.fn()
    const next = mock.fn()
    const a = await root.plugin(old, 'a')
    const b = await root.plugin(next, 'b')

    root.registry.replace(old, next)
    await a.await()

    expect(root.registry.size).to.equal(1)
    expect(a.runtime).to.equal(b.runtime)
    expect([...a.runtime!.fibers].map(fiber => fiber.config).sort()).to.deep.equal(['a', 'b'])
    // the fiber of `next` is not restarted
    expect(next.mock.calls.map(call => call.arguments[1])).to.deep.equal(['b', 'a'])
  })

  it('restarts a failed fiber', async () => {
    const root = new Context()
    const old = () => { throw new Error('failed') }
    const next = mock.fn()
    const fiber = root.plugin(old)
    await fiber.await().catch(() => {})
    expect(fiber.state).to.equal(FiberState.FAILED)

    root.registry.replace(old, next)
    await fiber.await()
    expect(fiber.state).to.equal(FiberState.ACTIVE)
    expect(next.mock.calls).to.have.length(1)
  })

  it('leaves a fiber failed when the new plugin fails to apply', async () => {
    const root = new Context()
    const old = () => {}
    const fiber = await root.plugin(old)

    root.registry.replace(old, () => { throw new Error('failed') })
    await expect(fiber.await()).rejects.toThrow('failed')
    expect(fiber.state).to.equal(FiberState.FAILED)
  })

  it('forwards the old plugin to the new one', async () => {
    const root = new Context()
    const old = mock.fn()
    const apply = mock.fn()
    const next = { inject: ['dep'], apply }
    await root.plugin(old)
    root.registry.replace(old, next)

    const fiber = root.plugin(old)
    expect(Object.keys(fiber.inject)).to.deep.equal(['dep'])
    expect(fiber.runtime).to.equal(root.registry.get(next))
    expect(root.registry.get(old)).to.equal(root.registry.get(next))
    // the alias is not a registered plugin
    expect(root.registry.size).to.equal(1)
    expect([...root.registry.keys()]).to.deep.equal([apply])

    root.provide('dep', {})
    await sleep()
    expect(old.mock.calls).to.have.length(1)
    expect(apply.mock.calls).to.have.length(2)
  })

  it('forwards a plugin that is not registered', async () => {
    const root = new Context()
    const old = mock.fn()
    const next = mock.fn()
    expect(root.registry.replace(old, next)).to.deep.equal([])
    expect(root.registry.size).to.equal(0)

    await root.plugin(old)
    expect(old.mock.calls).to.have.length(0)
    expect(next.mock.calls).to.have.length(1)
  })

  it('follows a chain of replacements', async () => {
    const root = new Context()
    const a = mock.fn()
    const b = mock.fn()
    const c = mock.fn()
    const fiber = await root.plugin(a)
    root.registry.replace(a, b)
    root.registry.replace(a, c)
    await fiber.await()

    expect(fiber.runtime).to.equal(root.registry.get(c))
    expect([...root.registry.keys()]).to.deep.equal([c])
  })

  it('switches back to a replaced plugin', async () => {
    const root = new Context()
    const a = mock.fn()
    const b = mock.fn()
    const fiber = await root.plugin(a)
    root.registry.replace(a, b)
    root.registry.replace(b, a)
    await fiber.await()

    expect(fiber.runtime).to.equal(root.registry.get(a))
    expect([...root.registry.keys()]).to.deep.equal([a])
    expect(a.mock.calls).to.have.length(2)
  })

  it('unregisters the new plugin when its last fiber is disposed', async () => {
    const root = new Context()
    const old = () => {}
    const next = () => {}
    const fiber = await root.plugin(old)
    root.registry.replace(old, next)
    await fiber.await()

    await fiber.dispose()
    expect(root.registry.size).to.equal(0)
    expect(root.registry.has(next)).to.equal(false)
  })
})
