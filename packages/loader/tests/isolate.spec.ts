import { mock } from 'node:test'
import { expect } from 'chai'
import { Context, Service } from '@cordisjs/core'
import { defineProperty } from 'cosmokit'
import MockLoader from './utils'

describe('service isolation: basic', async () => {
  const root = new Context()
  root.plugin(MockLoader)

  const dispose = mock.fn()

  const foo = defineProperty(root.loader.mock('foo', (ctx: Context) => {
    ctx.on('dispose', dispose)
  }), 'inject', ['bar'])

  const Bar = root.loader.mock('bar', class Bar extends Service {
    static [Service.provide] = 'bar'
    static [Service.immediate] = true
  })

  const Qux = root.loader.mock('qux', class Qux extends Service {
    static [Service.provide] = 'qux'
    static [Service.immediate] = true
  })

  it('initiate', async () => {
    await root.loader.restart([{
      id: '1',
      name: 'bar',
    }, {
      id: '2',
      name: 'qux',
    }, {
      id: '3',
      name: 'foo',
    }])
    expect(root.registry.get(foo)).to.be.ok
    expect(root.registry.get(Bar)).to.be.ok
    expect(root.registry.get(Qux)).to.be.ok
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('add isolate on injector (relavent)', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
    await root.loader.restart([{
      id: '1',
      name: 'bar',
    }, {
      id: '2',
      name: 'qux',
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
    await root.loader.restart([{
      id: '1',
      name: 'bar',
    }, {
      id: '2',
      name: 'qux',
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
    await root.loader.restart([{
      id: '1',
      name: 'bar',
    }, {
      id: '2',
      name: 'qux',
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
    await root.loader.restart([{
      id: '1',
      name: 'bar',
    }, {
      id: '2',
      name: 'qux',
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
    await root.loader.restart([{
      id: '1',
      name: 'bar',
      isolate: {
        bar: true,
      },
    }, {
      id: '2',
      name: 'qux',
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
    await root.loader.restart([{
      id: '1',
      name: 'bar',
      isolate: {
        bar: true,
      },
    }, {
      id: '2',
      name: 'qux',
      isolate: {
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
    await root.loader.restart([{
      id: '1',
      name: 'bar',
    }, {
      id: '2',
      name: 'qux',
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
    await root.loader.restart([{
      id: '1',
      name: 'bar',
    }, {
      id: '2',
      name: 'qux',
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

  const dispose = mock.fn(() => {
    console.log(new Error())
  })

  const foo = Object.assign(root.loader.mock('foo', (ctx: Context) => {
    ctx.on('dispose', dispose)
  }), {
    inject: ['bar'],
    reusable: true,
  })

  const bar = Object.assign(root.loader.mock('bar', (ctx: Context, config: {}) => {
    ctx.set('bar', config)
  }), {
    reusable: true,
  })

  it('initiate', async () => {
    await root.loader.restart([{
      id: '1',
      name: 'foo',
    }, {
      id: '2',
      name: 'bar',
    }])
    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
  })

  let alpha!: string
  let beta!: string

  it('add isolate group', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    alpha = await root.loader.create({
      name: 'cordis/group',
      isolate: {
        bar: 'alpha',
      },
      config: [{
        name: 'bar',
        config: { value: 'alpha' },
      }],
    })

    beta = await root.loader.create({
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
    expect(root.registry.get(bar)?.children).to.have.length(3)
    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
  })

  it('realm reference', async () => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()

    const nested1 = await root.loader.create({
      name: 'foo',
    }, alpha)

    const nested2 = await root.loader.create({
      name: 'foo',
      isolate: {
        bar: 'beta',
      },
    }, alpha)

    const nested3 = await root.loader.create({
      name: 'foo',
      isolate: {
        bar: true,
      },
    }, alpha)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(foo.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
    expect(root.loader.entries[nested1]!.fork).to.be.ok
    expect(root.loader.entries[nested1]!.fork!.ctx.get('bar')!.value).to.equal('alpha')
    expect(root.loader.entries[nested2]!.fork).to.be.ok
    expect(root.loader.entries[nested2]!.fork!.ctx.get('bar')!.value).to.equal('beta')
    expect(root.loader.entries[nested3]!.fork).to.be.ok
    expect(root.loader.entries[nested3]!.fork!.ctx.get('bar')).to.be.undefined
  })
})
