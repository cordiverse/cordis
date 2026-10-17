import { Mock, mock } from 'node:test'
import { expect, describe, it, beforeAll, beforeEach } from 'vitest'
import { Context } from 'cordis'
import MockLoader, { sleep } from './utils.ts'

describe('Group: basic support', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => dispose)
  })

  beforeEach(() => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
  })

  let outer!: string
  let inner!: string

  it('initialize', async () => {
    outer = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [{
        name: 'foo',
      }],
    })

    inner = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [{
        name: 'foo',
      }],
    }, outer)

    await sleep()
    loader.expectFiber(outer)
    loader.expectFiber(inner)
    expect(foo.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('disable inner', async () => {
    await loader.update(inner, { disabled: true })

    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('disable outer', async () => {
    await loader.update(outer, { disabled: true })

    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('enable inner', async () => {
    await loader.update(inner, { disabled: null })

    expect(foo.mock.calls).to.have.length(0) // outer is still disabled
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('enable outer', async () => {
    await loader.update(outer, { disabled: null })

    await sleep()
    expect(foo.mock.calls).to.have.length(2)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })
})

describe('Group: transfer', () => {
  const root = new Context()
  const dispose = mock.fn()

  let loader!: MockLoader
  let foo!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => dispose)
  })

  beforeEach(() => {
    foo.mock.resetCalls()
    dispose.mock.resetCalls()
  })

  let alpha!: string
  let beta!: string
  let gamma!: string
  let id!: string

  it('initialize', async () => {
    id = await loader.create({
      name: 'foo',
    })

    alpha = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [],
    })

    beta = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      disabled: true,
      config: [],
    }, alpha)

    gamma = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [],
    }, beta)

    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('enabled -> enabled', async () => {
    await loader.update(id, {}, alpha)

    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('enabled -> disabled', async () => {
    await loader.update(id, {}, beta)

    expect(foo.mock.calls).to.have.length(0)
    expect(dispose.mock.calls).to.have.length(1)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('disabled -> disabled', async () => {
    await loader.update(id, {}, gamma)

    expect(foo.mock.calls).to.have.length(0) // outer is still disabled
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })

  it('disabled -> enabled', async () => {
    await loader.update(id, {}, null)

    expect(foo.mock.calls).to.have.length(1)
    expect(dispose.mock.calls).to.have.length(0)
    expect([...loader.entries()]).to.have.length(4)
  })
})

describe('Group: awaited reconciliation', () => {
  const root = new Context()

  let loader!: MockLoader
  let foo!: Mock<Function>
  let bar!: Mock<Function>

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    foo = loader.mock('foo', () => {})
    bar = loader.mock('bar', () => {})
  })

  let group!: string

  it('initialize', async () => {
    group = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      config: [{
        id: '1',
        name: 'foo',
      }],
    })

    await sleep()
    loader.expectEnable(foo)
    loader.expectDisable(bar)
  })

  it('config update settles children', async () => {
    // The group vetoes its own restart and reconciles children instead, so
    // that reconciliation is what the caller is really waiting for. A slow
    // import makes the difference observable: without the awaited chain the
    // update resolves while the new child is still being imported.
    const load = loader.import
    loader.import = async (name: string) => {
      await sleep(20)
      return load.call(loader, name)
    }
    try {
      await loader.update(group, {
        config: [{
          id: '1',
          name: 'foo',
        }, {
          id: '2',
          name: 'bar',
        }],
      })
    } finally {
      loader.import = load
    }

    loader.expectEnable(bar)
    loader.expectFiber('2')
  })

  it('drops a pending child removed during import', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const load = loader.import
    loader.import = async (name: string, getOuterStack) => {
      if (name === 'baz') {
        started.resolve()
        await release.promise
      }
      return load.call(loader, name, getOuterStack)
    }

    let bazCalls = 0
    loader.mock('baz', () => { bazCalls++ })

    try {
      const p1 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '3', name: 'baz' }],
      })
      await started.promise
      const p2 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }],
      })
      release.resolve()
      await Promise.all([p1, p2])
    } finally {
      loader.import = load
    }

    expect(bazCalls).to.equal(0)
    expect(loader.store['3']).to.be.undefined
  })

  it('drops a pending child disabled during import', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const load = loader.import
    loader.import = async (name: string, getOuterStack) => {
      if (name === 'qux') {
        started.resolve()
        await release.promise
      }
      return load.call(loader, name, getOuterStack)
    }

    let quxCalls = 0
    loader.mock('qux', () => { quxCalls++ })

    try {
      const p1 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '4', name: 'qux' }],
      })
      await started.promise
      const p2 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '4', name: 'qux', disabled: true }],
      })
      release.resolve()
      await Promise.all([p1, p2])
    } finally {
      loader.import = load
    }

    expect(quxCalls).to.equal(0)
    expect(loader.store['4']?.fiber).to.be.undefined
  })

  // the liveness check must also cover the await after it: an async
  // `loader/patch-context` hook can suspend the entry just as the import does
  it('drops a pending child removed during patch-context', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const off = root.on('loader/patch-context', async (entry: any, next: () => any) => {
      if (entry.options.name === 'zap') {
        started.resolve()
        await release.promise
      }
      return next()
    })

    let zapCalls = 0
    loader.mock('zap', () => { zapCalls++ })

    try {
      const p1 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '5', name: 'zap' }],
      })
      await started.promise
      const p2 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }],
      })
      release.resolve()
      await Promise.all([p1, p2])
    } finally {
      off()
      release.resolve()
    }

    expect(zapCalls).to.equal(0)
    expect(loader.store['5']).to.be.undefined
  })

  // the second check guards the disabled half of liveness: the entry is still
  // in the store here, so only `!this.disabled` can drop it
  it('drops a pending child disabled during patch-context', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const off = root.on('loader/patch-context', async (entry: any, next: () => any) => {
      if (entry.options.name === 'zip') {
        started.resolve()
        await release.promise
      }
      return next()
    })

    let zipCalls = 0
    loader.mock('zip', () => { zipCalls++ })

    try {
      const p1 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '6', name: 'zip' }],
      })
      await started.promise
      const p2 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '6', name: 'zip', disabled: true }],
      })
      release.resolve()
      await Promise.all([p1, p2])
    } finally {
      off()
      release.resolve()
    }

    expect(zipCalls).to.equal(0)
    expect(loader.store['6']?.fiber).to.be.undefined
  })

  // dropping the pending child must not strand the entry: the entry stays in
  // the configuration, so enabling it again runs the next update through the
  // normal init path and the plugin is applied
  it('applies a pending child enabled again after being dropped', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const load = loader.import
    loader.import = async (name: string, getOuterStack) => {
      if (name === 'quux') {
        started.resolve()
        await release.promise
      }
      return load.call(loader, name, getOuterStack)
    }

    let quuxCalls = 0
    loader.mock('quux', () => { quuxCalls++ })

    try {
      const p1 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '6', name: 'quux' }],
      })
      await started.promise
      const p2 = loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '6', name: 'quux', disabled: true }],
      })
      release.resolve()
      await Promise.all([p1, p2])

      // the import landed on a disabled entry, so the plugin was not applied
      expect(quuxCalls).to.equal(0)
      expect(loader.store['6']?.fiber).to.be.undefined

      // enabling it again is an ordinary update: the entry re-enters init
      await loader.update(group, {
        config: [{ id: '1', name: 'foo' }, { id: '6', name: 'quux', disabled: false }],
      })
      loader.expectFiber('6')
      expect(quuxCalls).to.equal(1)
    } finally {
      loader.import = load
    }
  })

})

describe('Group: intercept', () => {
  const root = new Context()
  const callback = mock.fn()

  let loader!: MockLoader

  beforeAll(async () => {
    await root.plugin(MockLoader)
    loader = root.loader as any
    loader.mock('foo', (ctx: Context) => {
      callback(ctx[Context.intercept])
    })
  })

  beforeEach(() => {
    callback.mock.resetCalls()
  })

  let outer!: string
  let inner!: string
  let id!: string

  it('initialize', async () => {
    outer = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      intercept: {
        foo: {
          a: 1,
        },
      },
      config: [],
    })

    inner = await loader.create({
      name: '@cordisjs/plugin-group',
      group: true,
      intercept: {
        foo: {
          b: 2,
        },
      },
      config: [],
    }, outer)
    
    id = await loader.create({
      name: 'foo',
      intercept: {
        foo: {
          c: 3,
        },
      },
    }, inner)

    expect(callback.mock.calls).to.have.length(1)
    const intercept = callback.mock.calls[0].arguments[0]
    expect(intercept.foo).to.deep.equal({ c: 3 })
    expect(Object.getPrototypeOf(intercept).foo).to.deep.equal({ b: 2 })
    expect(Object.getPrototypeOf(Object.getPrototypeOf(intercept)).foo).to.deep.equal({ a: 1 })
  })
})
