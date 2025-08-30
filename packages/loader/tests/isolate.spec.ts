import { Mock, mock } from 'node:test'
import { expect } from 'chai'
import { Context, FiberState, Service } from 'cordis'
import MockLoader, { sleep } from './utils'

describe('Service Isolation: basic', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  before(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    foo = Object.assign(loader.mock('foo', () => dispose), {
      inject: ['bar'],
    })

    bar = loader.mock('bar', class Bar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'bar')
      }
    })
  })

  beforeEach(() => {
    foo.mock.resetCalls()
    bar.mock.resetCalls()
    dispose.mock.resetCalls()
  })

  let provider!: string
  let injector!: string

  it('initiate', async () => {
    provider = await loader.create({ name: 'bar' })
    injector = await loader.create({ name: 'foo' })

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('add isolate on injector (relavent)', async () => {
    await loader.update(injector, {
      isolate: {
        bar: true,
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('add isolate on injector (irrelavent)', async () => {
    await loader.update(injector, {
      isolate: {
        bar: true,
        qux: true,
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on injector (relavent)', async () => {
    await loader.update(injector, {
      isolate: {
        qux: true,
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on injector (irrelavent)', async () => {
    await loader.update(injector, {
      isolate: null,
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('add isolate on provider (relavent)', async () => {
    await loader.update(provider, {
      isolate: {
        bar: true,
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('add isolate on provider (irrelavent)', async () => {
    await loader.update(provider, {
      isolate: {
        bar: true,
        qux: true,
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on provider (relavent)', async () => {
    await loader.update(provider, {
      isolate: {
        qux: true,
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on provider (irrelavent)', async () => {
    await loader.update(provider, {
      isolate: null,
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })
})

describe('Service Isolation: realm', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  before(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    foo = Object.assign(loader.mock('foo', () => dispose), {
      inject: ['bar'],
    })
  
    bar = Object.assign(loader.mock('bar', (ctx: Context, config = {}) => {
      ctx.provide('bar', config)
    }))
  })

  beforeEach(() => {
    foo.mock.resetCalls()
    bar.mock.resetCalls()
    dispose.mock.resetCalls()
  })

  let alpha!: string
  let beta!: string

  it('add isolate group', async () => {
    alpha = await loader.create({
      name: 'cordis/group',
      isolate: {
        bar: true,
      },
      config: [{
        name: 'bar',
        config: { value: 'alpha' },
      }],
    })

    beta = await loader.create({
      name: 'cordis/group',
      isolate: {
        bar: 'beta',
      },
      config: [{
        name: 'bar',
        config: { value: 'beta' },
      }],
    })

    await sleep()
    expect(root.registry.get(bar)?.fibers).to.have.length(2)
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('update isolate group (no change)', async () => {
    await loader.update(alpha, {
      isolate: {
        bar: true,
      },
    })

    await sleep()
    expect(root.registry.get(bar)?.fibers).to.have.length(2)
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  let nested1!: string
  let nested2!: string
  let nested3!: string

  it('realm reference', async () => {
    nested1 = await loader.create({
      name: 'foo',
    }, alpha)

    nested2 = await loader.create({
      name: 'foo',
      isolate: {
        bar: 'beta',
      },
    }, alpha)

    nested3 = await loader.create({
      name: 'foo',
      isolate: {
        bar: true,
      },
    }, alpha)

    await sleep()
    expect(foo.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
    const fiber1 = loader.expectFiber(nested1)
    expect(fiber1.ctx.get('bar')!.value).to.equal('alpha')
    expect(fiber1.state).to.equal(FiberState.ACTIVE)
    const fiber2 = loader.expectFiber(nested2)
    expect(fiber2.ctx.get('bar')!.value).to.equal('beta')
    expect(fiber2.state).to.equal(FiberState.ACTIVE)
    const fiber3 = loader.expectFiber(nested3)
    expect(fiber3.ctx.get('bar')).to.be.undefined
    expect(fiber3.state).to.equal(FiberState.PENDING)
  })

  it('special case: nested realms', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
  
    const dispose = mock.fn()
  
    const foo = Object.assign(loader.mock('foo', () => dispose), {
      inject: ['bar'],
    })
  
    Object.assign(loader.mock('bar', (ctx: Context, config = {}) => {
      ctx.provide('bar', config)
    }))

    const outer = await loader.create({
      name: 'cordis/group',
      config: [],
    })

    const inner = await loader.create({
      name: 'cordis/group',
      isolate: {
        bar: 'custom',
      },
      config: [],
    }, outer)

    await loader.create({
      name: 'bar',
      config: { value: 'custom' },
    }, inner)

    const  alpha = await loader.create({
      name: 'foo',
      isolate: {
        bar: 'custom',
      },
    })

    const beta = await loader.create({
      name: 'foo',
    }, inner)

    await sleep()
    const fiber1 = loader.expectFiber(alpha)
    const fiber2 = loader.expectFiber(beta)
    expect(fiber1.ctx.get('bar')!.value).to.equal('custom')
    expect(fiber2.ctx.get('bar')!.value).to.equal('custom')

    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(outer, {
      isolate: {
        bar: 'custom',
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)

    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(outer, {
      isolate: {},
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('special case: change provider', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
  
    const dispose = mock.fn()

    const foo = Object.assign(loader.mock('foo', () => dispose), {
      inject: ['bar'],
    })

    Object.assign(loader.mock('bar', (ctx: Context, config = {}) => {
      ctx.provide('bar', config)
    }))

    await loader.create({
      name: 'bar',
      isolate: {
        bar: 'alpha',
      },
      config: { value: 'alpha' },
    })

    await loader.create({
      name: 'bar',
      isolate: {
        bar: 'beta',
      },
      config: { value: 'beta' },
    })

    const group = await loader.create({
      name: 'cordis/group',
      isolate: {
        bar: 'alpha',
      },
      config: [],
    })

    const id = await loader.create({
      name: 'foo',
    }, group)

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    const fiber = loader.expectFiber(id)
    expect(fiber.ctx.get('bar')!.value).to.equal('alpha')

    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(group, {
      isolate: {
        bar: 'beta',
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(1)
    expect(fiber.ctx.get('bar')!.value).to.equal('beta')
  })

  it('special case: change injector', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as MockLoader
  
    const dispose = mock.fn()
  
    const foo = Object.assign(loader.mock('foo', () => dispose), {
      inject: ['bar'],
    })
  
    const bar = loader.mock('bar', (ctx: Context, config = {}) => {
      ctx.provide('bar', config)
    })

    const alpha = await loader.create({
      name: 'foo',
      isolate: {
        bar: 'alpha',
      },
    })

    const beta = await loader.create({
      name: 'foo',
      isolate: {
        bar: 'beta',
      },
    })

    const group = await loader.create({
      name: 'cordis/group',
      isolate: {
        bar: 'alpha',
      },
      config: [],
    })

    const inner = await loader.create({
      name: 'bar',
    }, group)

    await loader.expectFiber(inner)
    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    const fiber1 = loader.expectFiber(alpha)
    expect(fiber1.ctx.get('bar')).to.be.ok
    const fiber2 = loader.expectFiber(beta)
    expect(fiber2.ctx.get('bar')).to.be.undefined

    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(group, {
      isolate: {
        bar: 'beta',
      },
    })

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(1)
    expect(fiber1.ctx.get('bar')).to.be.undefined
    expect(fiber2.ctx.get('bar')).to.be.ok
  })
})

describe('Service Isolation: transfer', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  before(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    foo = Object.assign(loader.mock('foo', () => dispose), {
      'inject': ['bar']
    })

    bar = loader.mock('bar', class Bar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'bar')
      }
    })
  })

  beforeEach(() => {
    foo.mock.resetCalls()
    bar.mock.resetCalls()
    dispose.mock.resetCalls()
  })

  let group!: string
  let provider!: string
  let injector!: string

  it('initiate', async () => {
    group = await loader.create({
      name: 'cordis/group',
      isolate: {
        bar: true,
      },
      config: [],
    })

    provider = await loader.create({ name: 'bar' })
    injector = await loader.create({ name: 'foo' })

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('transfer injector into group', async () => {
    loader.update(injector, {}, group)

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('transfer provider into group', async () => {
    loader.update(provider, {}, group)

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('transfer injector out of group', async () => {
    loader.update(injector, {}, null)

    await sleep()
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('transfer provider out of group', async () => {
    loader.update(provider, {}, null)

    await sleep()
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })
})
