import { Context, Message } from 'cordis'
import { ConsoleExporter } from '@cordisjs/plugin-logger-console'
import { expect, describe, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'

describe('logger-console', () => {
  let ctx: Context
  let exporter: ConsoleExporter
  let data: string

  beforeAll(() => {
    vi.useFakeTimers({ now: Date.now() })
    ctx = new Context()
    exporter = new ConsoleExporter(ctx, { colors: 0, showDiff: true, showTime: '' })
    exporter.export = (msg: Message) => {
      data += exporter.render(msg) + '\n'
    }
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    data = ''
  })

  it('format error', () => {
    const inner = new Error('message')
    inner.stack = undefined
    const outer = new Error('outer')
    ;(outer as any).errors = [inner]
    ctx.logger('test').error(outer)
    expect(data).toBe('[E] test message +0ms\n')
  })

  it('format object', () => {
    vi.advanceTimersByTime(2)
    ctx.logger('test').info({ foo: 'bar' })
    expect(data).toBe("[I] test { foo: 'bar' } +2ms\n")
  })

  it('custom formatter', () => {
    vi.advanceTimersByTime(1)
    exporter.formatters.x = () => 'custom'
    ctx.logger('test').info('%x%%x')
    expect(data).toBe('[I] test custom%x +1ms\n')
  })

  it('log levels', () => {
    const logger = ctx.logger('test')
    logger.debug('%C', 'foo bar')
    expect(data).toBe('')

    logger.level = 3
    logger.debug('%C', 'foo bar')
    expect(data).toBeTruthy()
  })

  it('label style', () => {
    exporter.label = { align: 'right', width: 10, margin: 2 }
    ctx.logger('test').info('message\nmessage')
    expect(data).toBe([
      '      test  [I]  message\n',
      '                 message +0ms\n',
    ].join(''))
  })
})
