import { expect } from 'chai'
import { Context } from '../src'

describe('Extend', () => {
  it('basic support', () => {
    class S1 {}
    class S2 {}
    class S3 {}

    class C1 extends Context {
      s1: S1
      s2: S2
      s3: S3
    }

    class C2 extends C1 {}
    class C3 extends C1 {}

    C2.service('s2', S2)
    C1.service('s1', S1)
    C3.service('s3', S3)

    const c1 = new C1()
    expect(c1.s1).to.be.ok
    expect(c1.s2).to.be.undefined
    expect(c1.s3).to.be.undefined

    const c2 = new C2()
    expect(c2.s1).to.be.ok
    expect(c2.s2).to.be.ok
    expect(c2.s3).to.be.undefined

    const c3 = new C3()
    expect(c3.s1).to.be.ok
    expect(c3.s2).to.be.undefined
    expect(c3.s3).to.be.ok
  })

  it('service isolation', () => {
    class Temp {}
    class C1 extends Context {
      temp: Temp
    }

    class C2 extends C1 {}
    C2.service('temp')

    const plugin = (ctx: C1) => {
      ctx.temp = new Temp()
    }

    const c1 = new C1()
    c1.plugin(plugin)
    const c2 = new C2()
    c2.plugin(plugin)

    // `temp` is not a service of C1
    expect(c1.temp).to.be.not.ok
    expect(c2.temp).to.be.ok
  })
})
