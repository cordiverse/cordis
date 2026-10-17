import { expect, describe, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import * as yaml from 'js-yaml'
import { harness, plugin } from './utils.ts'

describe('Include rebind', () => {
  const { setup } = harness()

  // `./config-plugin` and `./extra-plugin` are the two identities. Include
  // resolves them next to the config file, and a disabled write is flushed by settle().
  it('rebinds a live entry when the file changes its name', async () => {
    const app = await setup('tmp-rebind-name.yml', [plugin('a', 1)])
    expect(app.ctx.bail('test/config', 'a')).to.deep.equal({ tag: 'a', value: 1 })
    expect(app.ctx.bail('test/get-extra')).to.be.undefined

    await writeFile(app.filename, yaml.dump([{
      id: 'a',
      name: './extra-plugin',
      config: { tag: 'a', value: 1 },
    }]))
    await app.settle()

    expect(app.ctx.bail('test/get-extra')).to.equal('extra')
    expect(app.ctx.bail('test/config', 'a')).to.be.undefined
    expect('disabled' in app.include().store.a!.options).to.equal(false)
    expect((await app.text()).includes('disabled')).to.equal(false)
  }, 10000)
})
