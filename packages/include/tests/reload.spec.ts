import { expect, describe, it } from 'vitest'
import { harness } from './utils.ts'

const INNER = '- id: inner\n  name: ./test-component\n'
const INNER_EXTRA = '- id: inner\n  name: ./test-component\n- id: extra\n  name: ./extra-component\n'
const NOT_AN_ARRAY = 'inner: ./test-component\n'
const UNPARSABLE = '- {\n'

describe('Include reload', () => {
  const { setup } = harness()

  it('re-applies patches on every reload', async () => {
    const app = await setup('tmp-reload-patches.yml', INNER, {
      patches: [
        { id: 'inner', disabled: true },
      ],
    })
    expect(app.ctx.bail('test/get-value')).to.be.undefined

    await app.write(INNER_EXTRA)
    await app.settle()

    // the new entry loads, and the overlay is applied to the new parse too
    expect(app.ctx.bail('test/get-extra')).to.equal('extra')
    expect(app.ctx.bail('test/get-value')).to.be.undefined
  }, 10000)

  it('rebuilds an entry whose name changes in the file', async () => {
    const app = await setup('tmp-reload-rename.yml', INNER)
    expect(app.ctx.bail('test/get-value')).to.equal('default')

    await app.write('- id: inner\n  name: ./extra-component\n')
    await app.settle()

    expect(app.ctx.bail('test/get-extra')).to.equal('extra')
    expect(app.ctx.bail('test/get-value')).to.be.undefined
    // the old component is not taken for a self-dispose
    expect(await app.text()).to.equal('- id: inner\n  name: ./extra-component\n')
  }, 10000)

  it('reverts an entry when its patch is removed', async () => {
    const app = await setup('tmp-reload-revert.yml', INNER, {
      patches: [
        { id: 'inner', disabled: true },
      ],
    })
    expect(app.ctx.bail('test/get-value')).to.be.undefined

    // patches apply to a clone of the cached parse, so dropping one reverts the entry
    await app.ctx.loader.update(app.id, {
      config: {
        path: './fixtures/tmp-reload-revert.yml',
      },
    })
    await app.settle()

    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('keeps the tree reloadable after an invalid file', async () => {
    const app = await setup('tmp-reload-invalid.yml', INNER)
    expect(app.ctx.bail('test/get-value')).to.equal('default')

    await app.write(NOT_AN_ARRAY)
    // refresh resolves on a bad file; the include reports it itself
    await app.settle()
    expect(app.logs('warn').some(line => line.includes('failed to validate config file'))).to.be.true
    expect(app.ctx.bail('test/get-value')).to.equal('default')

    // the cache still holds the last good file, so the next good file reads
    // as a change and reconciles against an intact tree
    await app.write(INNER_EXTRA)
    await app.settle()
    expect(app.ctx.bail('test/get-extra')).to.equal('extra')
    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('never overwrites an existing but unparsable file with initial', async () => {
    const app = await setup('tmp-reload-initial.yml', UNPARSABLE, {
      initial: [
        { id: 'extra', name: './extra-component' },
      ],
    })

    // only a missing file falls back to `initial`; a file we failed to parse
    // belongs to the user and must survive
    expect(await app.text()).to.equal(UNPARSABLE)
    expect(app.ctx.bail('test/get-extra')).to.be.undefined
  }, 10000)
})
