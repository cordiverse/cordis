import { describe, expect, it } from 'vitest'
import { Context, FiberState } from 'cordis'
import { EntryValidationError, validateOptions } from '../src/index.ts'
import MockLoader from './utils.ts'

describe('Loader: entry options validation', () => {
  const validate = (options: unknown) => validateOptions(options, ':')

  it('accept valid options', () => {
    expect(validate({ name: 'foo' })).to.deep.equal([])
    expect(validate({
      id: 'a',
      name: 'foo',
      group: false,
      disabled: { __jsExpr: 'true' },
      inject: ['bar'],
      intercept: { bar: {} },
      isolate: { bar: true, baz: 'label' },
      config: { __jsExpr: 'whatever' },
    })).to.deep.equal([])
    // nullish fields are absent
    expect(validate({ name: 'foo', group: null, disabled: null, inject: null })).to.deep.equal([])
    expect(validate({ name: 'foo', inject: { bar: { required: true } } })).to.deep.equal([])
    expect(validate({ name: 'group', group: true, config: [] })).to.deep.equal([])
  })

  it('reject a missing or invalid field', () => {
    expect(validate(null)).to.deep.equal([{ message: 'entry must be an object', path: [] }])
    expect(validate(['foo'])).to.deep.equal([{ message: 'entry must be an object', path: [] }])
    expect(validate({})).to.deep.equal([{ message: 'name is required', path: ['name'] }])
    expect(validate({ id: 1, name: 'foo' })).to.deep.equal([{ message: 'id must be a string', path: ['id'] }])
    expect(validate({ id: 'a:b', name: 'foo' })).to.deep.equal([{ message: 'id must not contain ":"', path: ['id'] }])
    expect(validate({ name: 'group', group: true })).to.deep.equal([{ message: 'config is required', path: ['config'] }])
    expect(validate({ name: 'group', group: true, config: {} })).to.deep.equal([{ message: 'config must be an array', path: ['config'] }])
    expect(validate({ name: 'foo', inject: ['bar', 1] })).to.deep.equal([{ message: 'inject.1 must be a string', path: ['inject', 1] }])
    expect(validate({ name: 'foo', inject: 'bar' })).to.deep.equal([{ message: 'inject must be an array or an object', path: ['inject'] }])
    expect(validate({ name: 'foo', intercept: [] })).to.deep.equal([{ message: 'intercept must be an object', path: ['intercept'] }])
    expect(validate({ name: 'foo', isolate: { bar: false } })).to.deep.equal([{ message: 'isolate.bar must be true or a string', path: ['isolate', 'bar'] }])
  })

  it('accept an expression only for disabled', () => {
    const expr = { __jsExpr: 'true' }
    expect(validate({ name: 'foo', disabled: 'yes' })).to.deep.equal([
      { message: 'disabled must be a boolean', path: ['disabled'] },
    ])
    expect(validate({ name: 'foo', disabled: { __jsExpr: 1 } })).to.have.length(1)
    expect(validate({ name: expr, group: expr, inject: expr, intercept: expr, isolate: expr }).map(issue => issue.path)).to.deep.equal([
      ['name'], ['group'], ['inject'], ['intercept'], ['isolate'],
    ])
  })

  it('reject invalid options at runtime before they are committed', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as unknown as MockLoader
    loader.mock('foo', () => {})

    await expect(loader.create({ name: 1 } as any)).rejects.toThrow(EntryValidationError)
    await expect(loader.create({ name: 1 } as any)).rejects.toThrow('invalid entry options:\n  - name must be a string (at name)')
    expect(loader.changes).to.deep.equal([])
    expect(loader.root.data).to.deep.equal([])

    const id = await loader.create({ name: 'foo' })
    loader.changes.splice(0)
    await expect(loader.update(id, { disabled: 'yes' } as any)).rejects.toThrow(EntryValidationError)
    expect(loader.changes).to.deep.equal([])
    expect(loader.store[id]!.options).to.deep.equal({ id, name: 'foo' })
    expect(loader.expectFiber(id).state).to.equal(FiberState.ACTIVE)
  })

  it('unload an entry whose options turn invalid, and reload it once fixed', async () => {
    const root = new Context()
    await root.plugin(MockLoader)
    const loader = root.loader as unknown as MockLoader
    const errors: any[] = []
    root.on('internal/error', error => errors.push(error))
    const foo = loader.mock('foo', () => {})

    await loader.read([{ id: 'a', name: 'foo' }, { id: 'b', name: 'foo' }])
    const fiber = loader.expectFiber('a')

    await loader.read([{ id: 'a', name: 'foo', group: 'no' }, { id: 'b', name: 'foo' }, 'oops'])
    expect(loader.store['a']).to.be.undefined
    expect(fiber.state).to.equal(FiberState.DISPOSED)
    expect(loader.expectFiber('b').state).to.equal(FiberState.ACTIVE)
    // the disposal is not mistaken for a self-dispose, which writes `disabled`
    expect(loader.changes).to.deep.equal([])

    await loader.read([{ id: 'a', name: 'foo' }, { id: 'b', name: 'foo' }])
    expect(loader.expectFiber('a').state).to.equal(FiberState.ACTIVE)
    expect(foo.mock.calls).to.have.length(3)
  })
})
