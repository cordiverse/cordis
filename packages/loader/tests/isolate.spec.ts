import { Mock, mock } from 'node:test'
import { expect } from 'chai'
import { Context, ScopeStatus, Service } from '@cordisjs/core'
import { defineProperty } from 'cosmokit'
import MockLoader from './utils'

describe('service isolation: basic', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  before(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    foo = loader.mock('foo', defineProperty((ctx: Context) => {
      ctx.on('dispose', dispose)
    }, 'inject', ['bar']))
  
    bar = loader.mock('bar', class Bar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'bar')
      }
    })

    await loader.start()
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

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('add isolate on injector (relavent)', async () => {
    await loader.update(injector, {
      isolate: {
        bar: true,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
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

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on injector (relavent)', async () => {
    await loader.update(injector, {
      isolate: {
        qux: true,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on injector (irrelavent)', async () => {
    await loader.update(injector, {
      isolate: null,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('add isolate on provider (relavent)', async () => {
    await loader.update(provider, {
      isolate: {
        bar: true,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
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

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on provider (relavent)', async () => {
    await loader.update(provider, {
      isolate: {
        qux: true,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on provider (irrelavent)', async () => {
    await loader.update(provider, {
      isolate: null,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })
})

describe('service isolation: realm', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  before(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    foo = Object.assign(loader.mock('foo', (ctx: Context) => {
      ctx.on('dispose', dispose)
    }), {
      inject: ['bar'],
    })
  
    bar = Object.assign(loader.mock('bar', (ctx: Context, config = {}) => {
      ctx.set('bar', config)
    }))

    await loader.start()
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

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.registry.get(bar)?.scopes).to.have.length(2)
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('update isolate group (no change)', async () => {
    await loader.update(alpha, {
      isolate: {
        bar: true,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.registry.get(bar)?.scopes).to.have.length(2)
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

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
    const fork1 = loader.expectScope(nested1)
    expect(fork1.ctx.get('bar')!.value).to.equal('alpha')
    expect(fork1.status).to.equal(ScopeStatus.ACTIVE)
    const fork2 = loader.expectScope(nested2)
    expect(fork2.ctx.get('bar')!.value).to.equal('beta')
    expect(fork2.status).to.equal(ScopeStatus.ACTIVE)
    const fork3 = loader.expectScope(nested3)
    expect(fork3.ctx.get('bar')).to.be.undefined
    expect(fork3.status).to.equal(ScopeStatus.PENDING)
  })

  it('special case: nested realms', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as unknown as MockLoader
  
    const dispose = mock.fn()
  
    const foo = Object.assign(loader.mock('foo', (ctx: Context) => {
      ctx.on('dispose', dispose)
    }), {
      inject: ['bar'],
    })
  
    Object.assign(loader.mock('bar', (ctx: Context, config = {}) => {
      ctx.set('bar', config)
    }))

    await loader.start()

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

    await new Promise((resolve) => setTimeout(resolve, 0))
    const fork1 = loader.expectScope(alpha)
    const fork2 = loader.expectScope(beta)
    expect(fork1.ctx.get('bar')!.value).to.equal('custom')
    expect(fork2.ctx.get('bar')!.value).to.equal('custom')

    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(outer, {
      isolate: {
        bar: 'custom',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)

    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(outer, {
      isolate: {},
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('special case: change provider', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as unknown as MockLoader
  
    const dispose = mock.fn()
  
    const foo = Object.assign(loader.mock('foo', (ctx: Context) => {
      ctx.on('dispose', dispose)
    }), {
      inject: ['bar'],
    })
  
    Object.assign(loader.mock('bar', (ctx: Context, config = {}) => {
      ctx.set('bar', config)
    }))

    await loader.start()

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

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    const fork = loader.expectScope(id)
    expect(fork.ctx.get('bar')!.value).to.equal('alpha')

    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(group, {
      isolate: {
        bar: 'beta',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(1)
    expect(fork.ctx.get('bar')!.value).to.equal('beta')
  })

  it('special case: change injector', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as unknown as MockLoader
  
    const dispose = mock.fn()
  
    const foo = Object.assign(loader.mock('foo', (ctx: Context) => {
      ctx.on('dispose', dispose)
    }), {
      inject: ['bar'],
    })
  
    const bar = loader.mock('bar', (ctx: Context, config = {}) => {
      ctx.set('bar', config)
    })

    await loader.start()

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

    await loader.expectScope(inner)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    const fork1 = loader.expectScope(alpha)
    expect(fork1.ctx.get('bar')).to.be.ok
    const fork2 = loader.expectScope(beta)
    expect(fork2.ctx.get('bar')).to.be.undefined

    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(group, {
      isolate: {
        bar: 'beta',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(1)
    expect(fork1.ctx.get('bar')).to.be.undefined
    expect(fork2.ctx.get('bar')).to.be.ok
  })
})

describe('service isolation: transfer', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  before(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any

    foo = loader.mock('foo', defineProperty((ctx: Context) => {
      ctx.on('dispose', dispose)
    }, 'inject', ['bar']))

    bar = loader.mock('bar', class Bar extends Service {
      constructor(ctx: Context) {
        super(ctx, 'bar')
      }
    })

    await loader.start()
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

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('transfer injector into group', async () => {
    loader.update(injector, {}, group)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('transfer provider into group', async () => {
    loader.update(provider, {}, group)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('transfer injector out of group', async () => {
    loader.update(injector, {}, null)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('transfer provider out of group', async () => {
    loader.update(provider, {}, null)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })
})
