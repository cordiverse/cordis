import { expect } from 'chai'
import { Context, Service } from '../src'

describe('Functional Service', () => {
  it('functional service', async () => {
    interface Config {}

    interface Foo {
      (init?: Config): Config
    }

    class Foo extends Service {
      constructor(ctx: Context, public config: Config) {
        super(ctx, 'foo')
      }

      protected [Service.invoke](init?: Config) {
        expect(this.ctx).to.be.instanceof(Context)
        let result = { ...this.config }
        let intercept = this.ctx[Context.intercept]
        while (intercept) {
          Object.assign(result, intercept.foo)
          intercept = Object.getPrototypeOf(intercept)
        }
        Object.assign(result, init)
        return result
      }

      invoke() {
        return this()
      }

      extend(config?: Config) {
        return this[Service.extend]({
          config: { ...this.config, ...config },
        })
      }
    }

    const root = new Context()
    await root.plugin(Foo, { a: 1 })

    // access from context
    expect(root.foo()).to.deep.equal({ a: 1 })
    const ctx1 = root.intercept('foo', { b: 2 })
    expect(ctx1.foo()).to.deep.equal({ a: 1, b: 2 })
    const foo1 = ctx1.foo
    expect(foo1).to.be.instanceof(Foo)

    // create extension
    const foo2 = root.foo.extend({ c: 3 })
    expect(foo2).to.be.instanceof(Foo)
    expect(foo2()).to.deep.equal({ a: 1, c: 3 })
    const foo3 = foo1.extend({ d: 4 })
    expect(foo3).to.be.instanceof(Foo)
    expect(foo3.invoke()).to.deep.equal({ a: 1, b: 2, d: 4 })

    // context traceability
    expect(foo1.invoke()).to.deep.equal({ a: 1, b: 2 })
  })
})
