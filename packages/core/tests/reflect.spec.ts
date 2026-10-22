import { expect, describe, it, vi } from 'vitest'
import { mock } from 'node:test'
import { Context, FiberState } from '../src/index.ts'
import { sleep } from './utils.ts'

describe('Reflect', () => {
  it('Context.is()', () => {
    class SubContext extends Context {}

    expect(Context.is(new SubContext())).to.equal(true)
  })

  it('access check', async () => {
    const root = new Context()

    await root.plugin((ctx) => {
      expect(() => ctx['prototype']).to.not.throw()
      expect(() => ctx.constructor).to.not.throw()
      expect(() => ctx.bar).to.throw('cannot get property "bar" without inject')
      expect(() => ctx.bar = 0).to.throw('cannot set property "bar" without provide')
    })

    await root.plugin((ctx) => {
      expect(() => ctx.foo = 0).to.throw('cannot set property "foo" without provide')
      expect(() => ctx.provide('foo')).to.not.throw()
      expect(() => ctx.provide('foo')).to.throw('service "foo" has been registered at <root>')
      expect(() => ctx.foo = 0).to.not.throw()
    })
  })

  it('service injection', async () => {
    const root = new Context()
    const warn = mock.fn()
    ;(root.logger as any).warn = warn
    root.mixin('foo', ['bar'])
    root.provide('foo')
    root.set('foo', { bar: 1 })

    // foo is a service
    expect(root.get('foo')).to.be.ok
    // bar is a mixin
    expect(root.get('bar')).to.be.undefined
    // baseUrl is a property
    expect(root.get('baseUrl')).to.be.undefined

    root.inject(['foo'], (ctx) => {
      warn.mock.resetCalls()
      expect(warn.mock.calls).to.have.length(0)

      ctx.extend({ baz: 2 }).plugin((ctx) => {
        warn.mock.resetCalls()
        expect(ctx.baz).to.equal(2)
        expect(warn.mock.calls).to.have.length(0)
      })
    })
  })

  it('service inject leak', async () => {
    const root = new Context()
    root.provide('foo')
    root.set('foo', { bar: 1 })
    const fiber = await root.inject(['foo'], () => {})
    expect(fiber.ctx.foo).to.be.ok
    await fiber.dispose()
    expect(() => fiber.ctx.foo).to.throw('cannot get required service "foo" in inactive context')
  })

  it('does not apply a dependent when publication throws', async () => {
    const root = new Context()
    const applied: any[] = []
    const fiber = root.inject(['foo'], (ctx) => {
      applied.push(ctx.foo)
    })
    expect(fiber.state).to.equal(FiberState.PENDING)

    const off = root.on('internal/service', (_name, value) => {
      if (value !== undefined) throw new Error('svc')
    })

    expect(() => root.provide('foo', { n: 1 })).to.throw('svc')
    await sleep()
    expect(applied).to.have.length(0)
    expect(fiber.state).to.equal(FiberState.PENDING)
    expect(root.foo).to.equal(undefined)

    off()
    root.provide('foo', { n: 2 })
    await sleep()
    expect(applied).to.deep.equal([{ n: 2 }])
  })

  it('keeps the original error when retraction throws', async () => {
    const root = new Context()
    const applied: any[] = []
    const fiber = root.inject(['foo'], (ctx) => {
      applied.push(ctx.foo)
    })
    const retract = new Error('retract')
    root.on('internal/service', (_name, value) => {
      throw value !== undefined ? new Error('publish') : retract
    })
    const log = vi.spyOn(root.logger, 'error').mockImplementation(() => {})
    try {
      expect(() => root.provide('foo', { n: 1 })).to.throw('publish')
      await sleep()
      expect(log).toHaveBeenCalledWith(retract)
      expect([...root.fiber.provisions].some((impl) => impl.name === 'foo')).to.equal(false)
      expect(root.foo).to.equal(undefined)
      expect(applied).to.have.length(0)
      expect(fiber.state).to.equal(FiberState.PENDING)
    } finally {
      log.mockRestore()
    }
  })

  it('removes the provision when disposal notification throws', async () => {
    const root = new Context()
    const dispose = root.provide('foo', { n: 1 })
    root.on('internal/service', () => {
      throw new Error('later')
    })
    await expect(dispose()).rejects.toThrow('later')
    expect([...root.fiber.provisions].some((impl) => impl.name === 'foo')).to.equal(false)
  })
})
