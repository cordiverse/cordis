import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { handleError } from '../src/error.ts'

function setup() {
  const ctx = new Context()
  const logged: any[] = []
  ctx.logger.exporter({ colors: 0, levels: { default: 4 }, export: message => logged.push(message.args[0]) })
  return { ctx, logged }
}

describe('handleError', () => {
  it('reports an empty errors array instead of swallowing it', () => {
    const { ctx, logged } = setup()
    handleError(ctx, new AggregateError([]))
    expect(logged).to.have.length(1)
  })

  it('reports a plain error', () => {
    const { ctx, logged } = setup()
    handleError(ctx, new Error('boom'))
    expect(logged).to.have.length(1)
  })

  it('reports a build failure without a location', () => {
    const { ctx, logged } = setup()
    handleError(ctx, { errors: [{ text: 'no location' }] })
    expect(logged).toEqual(['no location'])
  })

  it('reports a build failure whose source cannot be read', () => {
    const { ctx, logged } = setup()
    handleError(ctx, { errors: [{ text: 'bad', location: { file: '/nope.ts', line: 1, column: 1 } }] })
    expect(logged).to.have.length(1)
  })
})
