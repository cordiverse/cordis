import { expect, describe, it } from 'vitest'
import { harness } from './utils.ts'

const base = [
  '- id: timer',
  '  name: \'@cordisjs/timer\'',
  '- id: group',
  '  name: \'@cordisjs/group\'',
  '  group: true',
  '  config:',
  '    - id: inner',
  '      name: ./test-component',
  '',
].join('\n')

describe('Include patches', () => {
  const { setup } = harness()

  it('should load without patches', async () => {
    const app = await setup('base.yml', base)
    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should disable an entry via patch', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        { id: 'inner', disabled: true },
      ],
    })
    // inner component should be disabled
    expect(app.ctx.bail('test/get-value')).to.be.undefined
  }, 10000)

  it('should override config via patch', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        { id: 'inner', config: { custom: true } },
      ],
    })
    // Component should still load (config override doesn't break it)
    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should warn on name mismatch and skip patch', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        { id: 'inner', name: 'wrong-name', disabled: true },
      ],
    })
    expect(app.logs('warn').some(line => line.includes('name mismatch'))).to.be.true
    // Component should still be active (patch was skipped due to name mismatch)
    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should warn on non-existent id', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        { id: 'nonexistent', disabled: true },
      ],
    })
    expect(app.logs('warn').some(line => line.includes('nonexistent'))).to.be.true
    // Should still work, patch just gets warned and ignored
    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should insert entries into root group', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        {
          insert: [
            { name: './extra-component' },
          ],
        },
      ],
    })
    expect(app.ctx.bail('test/get-extra')).to.equal('extra')
    // Original component should still work
    expect(app.ctx.bail('test/get-value')).to.equal('default')
  }, 10000)

  it('should insert entries into a specific group', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        {
          id: 'group',
          insert: [
            { name: './extra-component' },
          ],
        },
      ],
    })
    expect(app.ctx.bail('test/get-extra')).to.equal('extra')
  }, 10000)

  it('should warn when inserting into a non-group entry', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        {
          id: 'timer',
          insert: [
            { name: './extra-component' },
          ],
        },
      ],
    })
    expect(app.logs('warn').some(line => line.includes('not a group'))).to.be.true
    expect(app.ctx.bail('test/get-value')).to.equal('default')
    // extra component should NOT be loaded (timer is not a group)
    expect(app.ctx.bail('test/get-extra')).to.be.undefined
  }, 10000)

  it('should apply multiple patches', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        { id: 'inner', disabled: true },
        {
          insert: [
            { name: './extra-component' },
          ],
        },
      ],
    })
    // inner disabled, extra loaded
    expect(app.ctx.bail('test/get-value')).to.be.undefined
    expect(app.ctx.bail('test/get-extra')).to.equal('extra')
  }, 10000)

  it('should let a later patch address a row inserted by an earlier patch', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        { insert: [{ id: 'added', name: './extra-component' }] },
        { id: 'added', disabled: true },
      ],
    })
    expect(app.ctx.bail('test/get-value')).to.equal('default')
    // inserted rows are indexed as they land, so the second patch finds `added`
    expect(app.ctx.bail('test/get-extra')).to.be.undefined
  }, 10000)

  it('should validate name consistency (matching name is ok)', async () => {
    const app = await setup('base.yml', base, {
      patches: [
        { id: 'inner', name: './test-component', disabled: true },
      ],
    })
    // Name matches, so patch should apply and inner should be disabled
    expect(app.ctx.bail('test/get-value')).to.be.undefined
  }, 10000)
})
