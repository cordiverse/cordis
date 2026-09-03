import { CircularDependencyError, Context, FiberState, Service } from '../src'
import { describe, expect, it } from 'vitest'

describe('Dependency Graph', () => {
  it('rejects a self dependency', () => {
    class Self extends Service {
      static provide = 'self'
      static inject = ['self']

      constructor(ctx: Context) {
        super(ctx)
      }
    }

    const root = new Context()
    expect(() => root.plugin(Self)).to.throw(CircularDependencyError)
  })

  it('rejects an indirect dependency cycle', async () => {
    class A extends Service {
      static provide = 'a'
      static inject = ['b']
      constructor(ctx: Context) { super(ctx) }
    }

    class B extends Service {
      static provide = 'b'
      static inject = ['c']
      constructor(ctx: Context) { super(ctx) }
    }

    class C extends Service {
      static provide = 'c'
      static inject = ['a']
      constructor(ctx: Context) { super(ctx) }
    }

    const root = new Context()
    const fiberA = await root.plugin(A)
    const fiberB = await root.plugin(B)
    expect(() => root.plugin(C)).to.throw('A -> B -> C -> A')
    expect(fiberA.state).to.equal(FiberState.PENDING)
    expect(fiberB.state).to.equal(FiberState.PENDING)
  })

  it('does not connect services from different isolates', async () => {
    class A extends Service {
      static provide = 'a'
      static inject = ['b']
      constructor(ctx: Context) { super(ctx) }
    }

    class B extends Service {
      static provide = 'b'
      static inject = ['a']
      constructor(ctx: Context) { super(ctx) }
    }

    const root = new Context()
    const ctxA = root.isolate('a').isolate('b')
    const ctxB = root.isolate('a').isolate('b')
    const fiberA = await ctxA.plugin(A)
    const fiberB = await ctxB.plugin(B)
    expect(fiberA.state).to.equal(FiberState.PENDING)
    expect(fiberB.state).to.equal(FiberState.PENDING)
  })

  it('enforces the static provide contract', async () => {
    const Broken = Object.assign(function broken() {}, {
      provide: 'missing',
    })

    const root = new Context()
    await expect(root.plugin(Broken)).rejects.toThrow(
      'plugin <broken> declared service "missing" but did not provide it',
    )
  })

  it('tracks dynamic providers until disposal', async () => {
    class Foo extends Service {
      static provide = 'foo'
      constructor(ctx: Context) { super(ctx) }
    }

    const root = new Context()
    const dispose = root.provide('foo', {})
    expect(() => root.plugin(Foo)).to.throw(
      'service "foo" is provided by both <root> and <Foo>',
    )

    await dispose()
    await expect(root.plugin(Foo)).resolves.toBeDefined()
  })
})
