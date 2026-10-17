import { Context, Service } from '../src/index.ts'
import { Message } from '../src/logger.ts'
import { describe, expect, it, vi } from 'vitest'
import { sleep } from './utils.ts'

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

  // An exporter is user code. A sink that throws must not reach the caller,
  // and must not keep the message from the other sinks.
  it('keeps a failing exporter from breaking the caller', () => {
    const ctx = new Context()
    ctx.logger.exporters.clear()
    const captured: Message[] = []
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      ctx.logger.exporter({ export: () => { throw new Error('sink broken') } })
      ctx.logger.exporter({ export: message => captured.push(message) })

      expect(() => ctx.logger.info('still here')).to.not.throw()
      expect(captured.map(message => message.args[0])).toEqual(['still here'])
      expect(String(spy.mock.calls[0]?.[0])).to.include('sink broken')

      ctx.logger.info('and again')
      expect(captured.map(message => message.args[0])).toEqual(['still here', 'and again'])
      expect(spy.mock.calls).toHaveLength(2)

      // The exporter object is user code as well: reading its level can throw,
      // and that reaches the caller just like a throwing sink does.
      const before = spy.mock.calls.length
      ctx.logger.exporter({
        get levels(): Record<string, number> { throw new Error('levels broken') },
        export: () => {},
      })
      expect(() => ctx.logger.info('third')).to.not.throw()
      expect(captured.map(message => message.args[0])).toEqual(['still here', 'and again', 'third'])
      expect(spy.mock.calls).toHaveLength(before + 2)
    } finally {
      spy.mockRestore()
    }
  })

  // A browser build has no `process`; the report still has to land somewhere.
  it('reports through the console when process is absent', () => {
    const ctx = new Context()
    ctx.logger.exporters.clear()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('process', undefined)
    try {
      ctx.logger.exporter({ export: () => { throw new Error('sink broken') } })
      expect(() => ctx.logger.info('still here')).to.not.throw()
      expect(String(spy.mock.calls[0]?.[0])).to.include('sink broken')
    } finally {
      vi.unstubAllGlobals()
      spy.mockRestore()
    }
  })

  // A sink may return a promise; its rejection is a failure of the same sink.
  it('reports a rejected exporter promise', async () => {
    const ctx = new Context()
    ctx.logger.exporters.clear()
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      ctx.logger.exporter({ export: async () => { throw new Error('async sink broken') } })
      ctx.logger.info('still here')
      await sleep(0)
      expect(spy.mock.calls.some(call => String(call[0]).includes('async sink broken'))).to.equal(true)
    } finally {
      spy.mockRestore()
    }
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
