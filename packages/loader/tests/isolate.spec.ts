import { mock } from 'node:test'
import { expect } from 'chai'
import { Context, ScopeStatus, Service } from '@cordisjs/core'
import { defineProperty } from 'cosmokit'
import MockLoader from './utils'

describe('service isolation: basic', async () => {
  const root = new Context()
  root.plugin(MockLoader)
  const loader = root.loader

  const dispose = mock.fn()

  const foo = loader.mock('foo', defineProperty((ctx: Context) => {
    ctx.on('dispose', dispose)
  }, 'inject', ['bar']))

  const Bar = loader.mock('bar', class Bar extends Service {
    static [Service.provide] = 'bar'
    static [Service.immediate] = true
  })

  before(() => loader.start())

  it('initiate', async () => {
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
    }, {
      id: '3',
      name: 'foo',
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.registry.get(foo)).to.be.ok
    expect(root.registry.get(Bar)).to.be.ok
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('add isolate on injector (relavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
    }, {
      id: '3',
      name: 'foo',
      isolate: {
        bar: true,
      },
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('add isolate on injector (irrelavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
    }, {
      id: '3',
      name: 'foo',
      isolate: {
        bar: true,
        qux: true,
      },
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on injector (relavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
    }, {
      id: '3',
      name: 'foo',
      isolate: {
        qux: true,
      },
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on injector (irrelavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
    }, {
      id: '3',
      name: 'foo',
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('add isolate on provider (relavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
      isolate: {
        bar: true,
      },
    }, {
      id: '3',
      name: 'foo',
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
  })

  it('add isolate on provider (irrelavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
      isolate: {
        bar: true,
        qux: true,
      },
    }, {
      id: '3',
      name: 'foo',
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on provider (relavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
    }, {
      id: '3',
      name: 'foo',
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('remove isolate on provider (irrelavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    loader.root.fork!.update([{
      id: '1',
      name: 'bar',
    }, {
      id: '3',
      name: 'foo',
    }])

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })
})

describe('service isolation: realm', async () => {
  const root = new Context()
  root.plugin(MockLoader)
  const loader = root.loader

  const dispose = mock.fn(() => {
    console.log(new Error())
  })

  const foo = Object.assign(loader.mock('foo', (ctx: Context) => {
    ctx.on('dispose', dispose)
  }), {
    inject: ['bar'],
    reusable: true,
  })

  const bar = Object.assign(loader.mock('bar', (ctx: Context, config: {}) => {
    ctx.set('bar', config)
  }), {
    reusable: true,
  })

  before(() => loader.start())

  let alpha!: string
  let beta!: string

  it('add isolate group', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()

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
    expect(root.registry.get(bar)?.children).to.have.length(2)
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('update isolate group (no change)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    await loader.update(alpha, {
      isolate: {
        bar: true,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.registry.get(bar)?.children).to.have.length(2)
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  let nested1!: string
  let nested2!: string
  let nested3!: string

  it('realm reference', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()

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
    expect(loader.entries[nested1]!.fork).to.be.ok
    expect(loader.entries[nested1]!.fork!.ctx.get('bar')!.value).to.equal('alpha')
    expect(loader.entries[nested1]!.fork!.status).to.equal(ScopeStatus.ACTIVE)
    expect(loader.entries[nested2]!.fork).to.be.ok
    expect(loader.entries[nested2]!.fork!.ctx.get('bar')!.value).to.equal('beta')
    expect(loader.entries[nested2]!.fork!.status).to.equal(ScopeStatus.ACTIVE)
    expect(loader.entries[nested3]!.fork).to.be.ok
    expect(loader.entries[nested3]!.fork!.ctx.get('bar')).to.be.undefined
    expect(loader.entries[nested3]!.fork!.status).to.equal(ScopeStatus.PENDING)
  })
})
