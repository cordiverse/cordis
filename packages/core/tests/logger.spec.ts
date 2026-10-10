import { Context, Logger, Service } from '../src'
import { Exporter, Message } from '../src/logger'
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
    const baseExporter: Exporter = { export() {} }

    it('handles default formatters and escapes', () => {
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: [
        's:%s d:%d i:%i f:%f o:%o O:%O c:%c end %%',
        'str', 12.8, -3.2, 4.56, { a: 1 }, [2], 'hidden',
      ] }
      expect(Logger.format(baseExporter, msg)).toBe('s:str d:12 i:-3 f:4.56 o:{"a":1} O:[2] c: end %')
    })

    it('leaves unknown placeholder verbatim', () => {
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: ['unknown %z placeholder', 'foo'] }
      expect(Logger.format(baseExporter, msg)).toBe('unknown %z placeholder foo')
    })

    it('renders Error stack or falls back to message', () => {
      const err = new Error('boom')
      expect(Logger.format(baseExporter, { sn: 1, ts: 0, name: 'root', type: 'error', level: 0, args: [err] })).toContain('Error: boom')

      const errNoStack = new Error('pure message')
      errNoStack.stack = undefined
      expect(Logger.format(baseExporter, { sn: 1, ts: 0, name: 'root', type: 'error', level: 0, args: [errNoStack] })).toBe('pure message')
    })

    it('stringifies non-string leading argument through %o', () => {
      expect(Logger.format(baseExporter, { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: [{ foo: 'bar' }] })).toBe('{"foo":"bar"}')
    })

    it('appends remaining arguments and formats object arguments through %o', () => {
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: ['prefix', 'plain', { x: 1 }, 42] }
      expect(Logger.format(baseExporter, msg)).toBe('prefix plain {"x":1} 42')
    })

    it('prioritizes exporter-provided formatter over default', () => {
      const customExporter: Exporter = {
        formatters: { s: (val) => `custom:${val}` },
        export() {},
      }
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: ['val: %s', 'hello'] }
      expect(Logger.format(customExporter, msg)).toBe('val: custom:hello')
    })

    it('keeps message.args array immutable', () => {
      const args = ['count: %d', 10]
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args }
      Logger.format(baseExporter, msg)
      expect(args).toEqual(['count: %d', 10])
    })

    it('truncates lines exceeding maxLength and preserves line breaks', () => {
      const exporter: Exporter = { maxLength: 8, export() {} }
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: ['1234567890\nabc'] }
      expect(Logger.format(exporter, msg)).toBe('12345678...\nabc')
    })

    it('does not cut a truncated line inside an ANSI sequence', () => {
      const exporter: Exporter = { colors: 1, maxLength: 12, export() {} }
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: ['aaaaaaaaa%C', 'tail'] }
      const output = Logger.format(exporter, msg)
      // the cut lands on the twelfth visible character, never inside the escape
      expect(output.replace(/\u001b\[[0-9;]*m/g, '')).toBe('aaaaaaaaatai...')
      expect(output.endsWith('\u001b[0m')).to.equal(true)
      expect(output).to.not.match(/\u001b\[[0-9;]*$/)
    })

    it('counts maxLength in the characters a line shows', () => {
      // eight visible characters, so a limit of twelve leaves the line alone
      const exporter: Exporter = { colors: 1, maxLength: 12, export() {} }
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: ['abcdef%C', 'gh'] }
      const output = Logger.format(exporter, msg)
      expect(output).to.not.include('...')
      expect(output.replace(/\u001b\[[0-9;]*m/g, '')).toBe('abcdefgh')
    })

    it('leaves a coloured line alone when it shows exactly maxLength characters', () => {
      // the escape sits at the cut, so counting the raw string would cut it
      const exporter: Exporter = { colors: 1, maxLength: 8, export() {} }
      const msg: Message = { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: ['abcdef%C', 'gh'] }
      const output = Logger.format(exporter, msg)
      expect(output).to.not.include('...')
      expect(output).toBe('abcdef\u001b[36mgh\u001b[0m')
    })

    it('formats color according to exporter colors level and stays safe at colors: 0', () => {
      expect(Logger.color({ colors: 0, export() {} }, 1, 'text')).toBe('text')
      expect(Logger.color({ colors: 1, export() {} }, 1, 'text')).toBe('\u001b[31mtext\u001b[0m')
      expect(Logger.color({ colors: 2, export() {} }, 1, 'text', ';1')).toBe('\u001b[31;1mtext\u001b[0m')

      const msg: Message = { sn: 1, ts: 0, name: 'my-service', type: 'info', level: 2, args: ['tag: %C', 'target'] }
      expect(Logger.format({ colors: 0, export() {} }, msg)).toBe('tag: target')
    })

    it('renders empty, null and undefined arguments', () => {
      expect(Logger.format(baseExporter, { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: [] })).toBe('undefined')
      expect(Logger.format(baseExporter, { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: [null] })).toBe('null')
      expect(Logger.format(baseExporter, { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: [undefined] })).toBe('undefined')
      expect(Logger.format(baseExporter, { sn: 1, ts: 0, name: 'root', type: 'info', level: 2, args: ['val: %s, obj: %o, raw: %d', null, null, undefined] })).toBe('val: null, obj: null, raw: NaN')
    })
  })
})
