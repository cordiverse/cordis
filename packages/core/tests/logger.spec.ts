import { Context, Service } from '../src'
import { Logger, Message } from '../src/logger'
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

  describe('Logger.format', () => {
    const message = (args: any[], name = 'app'): Message => ({
      sn: 1, ts: 0, name, type: 'info', level: 2, args,
    })

    it('renders each default formatter', () => {
      const exporter = { colors: false }
      expect(Logger.format(exporter, message(['%s', 123]))).toBe('123')
      expect(Logger.format(exporter, message(['%d', 3.9]))).toBe('3')
      expect(Logger.format(exporter, message(['%i', 3.9]))).toBe('3')
      expect(Logger.format(exporter, message(['%f', '2.5']))).toBe('2.5')
      expect(Logger.format(exporter, message(['%o', { a: 1 }]))).toBe('{"a":1}')
      expect(Logger.format(exporter, message(['%O', { a: 1 }]))).toBe('{"a":1}')
      // `%c` is a no-op formatter: it consumes the argument and renders nothing
      expect(Logger.format(exporter, message(['%c', 'ignored']))).toBe('')
    })

    it('renders %% literally without consuming an argument', () => {
      expect(Logger.format({ colors: false }, message(['100%% done']))).toBe('100% done')
      expect(Logger.format({ colors: false }, message(['%%', 'kept']))).toBe('% kept')
    })

    it('leaves an unknown placeholder verbatim', () => {
      expect(Logger.format({ colors: false }, message(['%z', 'x']))).toBe('%z x')
    })

    it('renders a leading Error as its stack', () => {
      const error = new Error('boom')
      expect(Logger.format({ colors: false }, message([error]))).toBe(error.stack)
      // a stack-less error falls back to its message
      const bare = new Error('bare')
      bare.stack = ''
      expect(Logger.format({ colors: false }, message([bare]))).toBe('bare')
    })

    it('stringifies a non-string leading argument through %o', () => {
      expect(Logger.format({ colors: false }, message([{ a: 1 }, 'tail']))).toBe('{"a":1} tail')
    })

    it('appends remaining arguments, formatting objects through %o', () => {
      expect(Logger.format({ colors: false }, message(['%s', 'x', { a: 1 }, 2]))).toBe('x {"a":1} 2')
    })

    it('prefers an exporter-provided formatter over the default', () => {
      const exporter = { colors: false, formatters: { s: (value: any) => `<${value}>` } }
      expect(Logger.format(exporter, message(['%s', 'x']))).toBe('<x>')
    })

    it('does not mutate message.args', () => {
      const args = ['%s', 1]
      Logger.format({ colors: false }, message(args))
      expect(args).toEqual(['%s', 1])
    })

    it('truncates every line to maxLength', () => {
      const exporter = { colors: false, maxLength: 5 }
      expect(Logger.format(exporter, message(['abcdefghij']))).toBe('abcde...')
      expect(Logger.format(exporter, message(['a\nbcdefghij']))).toBe('a\nbcdef...')
    })

    it('keeps line breaks', () => {
      expect(Logger.format({ colors: false }, message(['a\nb']))).toBe('a\nb')
    })
  })

  describe('Logger.color', () => {
    it('returns plain text when colors are disabled', () => {
      expect(Logger.color({ colors: false }, 6, 'value')).toBe('value')
      expect(Logger.color({ colors: 0 }, 6, 'value')).toBe('value')
    })

    it('wraps the value in an ANSI sequence when colors are enabled', () => {
      expect(Logger.color({ colors: 1 }, 6, 'v')).toBe('\u001b[36mv\u001b[0m')
      // a 256-color code uses the 8;5; form
      expect(Logger.color({ colors: 1 }, 57, 'v')).toBe('\u001b[38;5;57mv\u001b[0m')
    })

    // `decoration` is a semicolon-prefixed modifier, as `logger-console` passes it
    it('appends the decoration only at colors >= 2', () => {
      expect(Logger.color({ colors: 1 }, 6, 'v', ';1')).toBe('\u001b[36mv\u001b[0m')
      expect(Logger.color({ colors: 2 }, 6, 'v', ';1')).toBe('\u001b[36;1mv\u001b[0m')
    })

    it('keeps the %C formatter safe when colors are disabled', () => {
      expect(Logger.format({ colors: 0 }, { sn: 1, ts: 0, name: 'app', type: 'info', level: 2, args: ['%C', 'v'] })).toBe('v')
      expect(Logger.format({ colors: 1 }, { sn: 1, ts: 0, name: 'app', type: 'info', level: 2, args: ['%C', 'v'] })).toMatch(/^\u001b\[3/)
    })
  })
})
