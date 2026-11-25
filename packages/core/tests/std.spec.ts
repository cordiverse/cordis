import { Context, Inject, type Namespace, Service, symbols } from '../src/index.ts'
import { expect, describe, it } from 'vitest'

class Foo extends Service<Foo.Config> {
  constructor(ctx: Context) {
    super(ctx, 'std:foo')
  }

  hello() {
    return 'foo'
  }

  config() {
    return this[Service.resolveIntercept]()
  }
}

namespace Foo {
  export interface Config {
    value?: number
  }
}

declare module '../src/index.ts' {
  interface Context {
    'std:foo': Foo
    'std:bar': number
    'std:receiver': () => unknown
    tools: Namespace<this, 'tools'>
    'tools:counter': { value: number, read(): number }
    'tools:read': () => number
  }
}

describe('Standard namespace', () => {
  it('retains the accessing context for each view of the namespace', () => {
    const root = new Context()
    const left = root.isolate('std:bar')
    const right = root.isolate('std:bar')
    left.provide('std:bar', 1)
    right.provide('std:bar', 2)
    const a = left.std
    const b = right.std
    expect(a.bar).to.equal(1)
    expect(b.bar).to.equal(2)
    const target = Reflect.get(a, symbols.original)
    expect(target).to.be.ok
    expect(Reflect.get(b, symbols.original)).to.equal(target)
  })

  it('forwards a function value with its ordinary call receiver', () => {
    const root = new Context()
    function receiver(this: unknown) { return this }
    root.provide('std:receiver', receiver)
    const std = root.std
    expect(std.receiver).to.equal(receiver)
    expect(std.receiver()).to.equal(std)
    expect(root['std:receiver']()).to.equal(root)
  })

  it('exposes services and mixins in a plugin namespace', async () => {
    const root = new Context()
    const plugin = await root.use(ctx => {
      ctx.reflect.namespace('tools')
      ctx.mixin('tools:counter', { read: 'tools:read' })
    })
    const counter = { value: 42, read() { return this.value } }
    await root.use(ctx => { ctx.provide('tools:counter', counter) })
    await root.inject(['tools:counter'], ctx => {
      expect(ctx.tools.counter).to.equal(counter)
      expect(ctx.tools.read()).to.equal(42)
    })
    await root.use(ctx => {
      expect(() => ctx.tools.read()).to.throw('cannot get property "tools:counter" without inject')
    })
    await plugin.dispose()
    expect('tools' in root).to.equal(false)
    expect(root.get('tools:counter')).to.equal(counter)
  })

  it('service access', async () => {
    const root = new Context()
    await root.use(Foo)

    await root.inject(['std:foo'], (ctx) => {
      expect(ctx.std.foo).to.be.instanceof(Foo)
      expect(ctx.std.foo.hello()).to.equal('foo')
      expect('foo' in ctx.std).to.equal(true)
    })

    await root.use((ctx) => {
      expect(() => ctx.std.foo).to.throw('cannot get property "std:foo" without inject')
      expect(() => (ctx.std as any).qux).to.throw('cannot get property "std:qux" without inject')
      expect('qux' in ctx.std).to.equal(false)
    })
  })

  it('property injection', async () => {
    const root = new Context()
    root.provide('std:bar')
    root.std.bar = 1
    expect(root.get('std:bar')).to.equal(1)
    await root.inject(['std:bar'], (ctx) => {
      expect(ctx.std.bar).to.equal(1)
      expect(() => ctx.std.bar = 2).to.throw('cannot set property "std:bar" in multiple fibers')
    })
  })

  it('access follows the def site', async () => {
    class Baz extends Service {
      static inject = ['std:foo']

      constructor(ctx: Context) {
        super(ctx, 'baz')
      }

      probe() {
        return this.ctx.std.foo.hello()
      }
    }

    class Qux extends Service {
      constructor(ctx: Context) {
        super(ctx, 'qux')
      }

      probe() {
        return this.ctx.std.foo.hello()
      }
    }

    const root = new Context()
    await root.use(Foo)
    await root.use(Baz)
    await root.use(Qux)

    await root.inject(['baz', 'qux'], (ctx) => {
      expect(ctx.baz.probe()).to.equal('foo')
      expect(() => ctx.qux.probe()).to.throw('cannot get property "std:foo" without inject')
    })
  })

  it('associated service', async () => {
    const root = new Context()
    await root.use(Foo)
    await root.use((ctx) => {
      ctx.provide('std:foo:qux', 1)
    })

    await root.inject(['std:foo', 'std:foo:qux'], (ctx) => {
      expect((ctx.std.foo as any).qux).to.equal(1)
    })
    await root.inject(['std:foo'], (ctx) => {
      expect(() => (ctx.std.foo as any).qux).to.throw('cannot get property "std:foo:qux" without inject')
    })
  })

  it('intercept', async () => {
    const root = new Context()
    await root.use(Foo)
    expect(root.intercept('std:foo', { value: 1 }).std.foo.config()).to.deep.equal({ value: 1 })
    // @ts-expect-error
    root.intercept<'std:foo'>('std:foo', { value: '1' })

    let config: any
    @Inject('std:foo', { value: 2 })
    class Consumer {
      constructor(ctx: Context) {
        config = ctx.std.foo.config()
      }
    }
    await root.use(Consumer)
    expect(config).to.deep.equal({ value: 2 })
  })

  it('reserved name', async () => {
    const root = new Context()
    await root.use((ctx) => {
      expect(() => ctx.std = {} as any).to.throw(TypeError)
    })
    expect(() => root.provide('std')).to.throw('property "std" is already declared as accessor')
  })
})
