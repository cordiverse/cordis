import { Context, Service } from '../src'
import { Message } from '../src/logger'
import { describe, expect, it } from 'vitest'
import { sleep } from './utils'

function setup() {
  const ctx = new Context()
  const captured: Message[] = []
  ctx.logger.exporter({
    colors: 0,
    levels: { default: 3 },
    export: (msg) => captured.push(msg),
  })
  return { ctx, captured }
}

describe('Logger', () => {
  it('keeps the bounded buffer in place and chronological', () => {
    const ctx = new Context()
    const buffer = ctx.logger.buffer
    ctx.logger.bufferSize = 2
    ctx.logger.info('one')
    ctx.logger.info('two')
    ctx.logger.info('three')
    expect(ctx.logger.buffer).toBe(buffer)
    expect(buffer.map(message => message.args[0])).toEqual(['two', 'three'])

    ctx.logger.bufferSize = 1
    ctx.logger.info('four')
    expect(buffer.map(message => message.args[0])).toEqual(['four'])

    ctx.logger.bufferSize = 0
    ctx.logger.info('five')
    expect(buffer).toEqual([])
  })

  it('disposes the exporter that registered the disposer', () => {
    const ctx = new Context()
    ctx.logger.exporters.clear()
    const first: Message[] = []
    const second: Message[] = []
    const disposeFirst = ctx.logger.exporter({ export: message => first.push(message) })
    const disposeSecond = ctx.logger.exporter({ export: message => second.push(message) })

    disposeFirst()
    ctx.logger.info('test')
    expect(first).toEqual([])
    expect(second).toHaveLength(1)

    disposeSecond()
    ctx.logger.info('test')
    expect(second).toHaveLength(1)
  })

  it('uses fiber name when called from outside any service', () => {
    const { ctx, captured } = setup()
    ctx.logger.debug('hello')
    expect(captured.map(m => m.name)).toEqual(['root'])
  })

  it('honours explicit name argument', () => {
    const { ctx, captured } = setup()
    ctx.logger('custom').debug('hello')
    expect(captured.map(m => m.name)).toEqual(['custom'])
  })

  it('honours intercept name', () => {
    const { ctx, captured } = setup()
    ctx.intercept('logger', { name: 'intercepted' }).logger.debug('hello')
    expect(captured.map(m => m.name)).toEqual(['intercepted'])
  })

  it('uses service name when called from inside a Service method (regression)', async () => {
    const { ctx, captured } = setup()

    class FooService extends Service {
      static name = 'foo:driver'
      constructor(ctx: Context) { super(ctx, 'foo') }
      action() {
        this.ctx.logger.debug('from action')
      }
    }

    await ctx.plugin(FooService)
    ctx.foo.action()
    await sleep()
    expect(captured.map(m => m.name)).toContain('foo:driver')
    expect(captured.map(m => m.name)).not.toContain('root')
  })

  it('still lets outer caller intercept override the service-derived name', async () => {
    const { ctx, captured } = setup()

    class FooService extends Service {
      static name = 'foo:driver'
      constructor(ctx: Context) { super(ctx, 'foo') }
      action() {
        this.ctx.logger.debug('from action')
      }
    }

    await ctx.plugin(FooService)
    ctx.intercept('logger', { name: 'caller-override' }).foo.action()
    await sleep()
    expect(captured.map(m => m.name)).toContain('caller-override')
    expect(captured.map(m => m.name)).not.toContain('foo:driver')
  })

  it('uses the innermost service name and restores the outer service', async () => {
    const { ctx, captured } = setup()

    class BarService extends Service {
      static name = 'bar:driver'
      constructor(ctx: Context) { super(ctx, 'bar') }
      action() {
        this.ctx.logger.debug('from bar')
      }
    }

    class FooService extends Service {
      static name = 'foo:driver'
      static inject = ['bar']
      constructor(ctx: Context) { super(ctx, 'foo') }
      action() {
        this.ctx.bar.action()
        this.ctx.logger.debug('from foo')
      }
    }

    await ctx.plugin(BarService)
    await ctx.plugin(FooService)
    await ctx.inject(['foo'], ctx => ctx.foo.action())

    expect(captured.map(m => [m.name, m.args[0]])).toEqual([
      ['bar:driver', 'from bar'],
      ['foo:driver', 'from foo'],
    ])
  })

  it('uses service name when called from inside [Service.init] (unchanged behaviour)', async () => {
    const { ctx, captured } = setup()

    class FooService extends Service {
      static name = 'foo:driver'
      constructor(ctx: Context) { super(ctx, 'foo') }
      async [Service.init]() {
        this.ctx.logger.debug('from init')
      }
    }

    await ctx.plugin(FooService)
    await sleep()
    expect(captured.map(m => m.name)).toContain('foo:driver')
  })
})
