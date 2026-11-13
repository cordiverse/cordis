import { Context } from 'cordis'
import { describe, it, expect } from 'vitest'
import MockLoader, { sleep } from './utils'

const GROUP = '@cordisjs/plugin-group'
const TEARDOWN_MS = 50

async function boot() {
  const root = new Context()
  await root.plugin(MockLoader)
  const loader = root.loader as MockLoader
  return { root, loader }
}

function slowPlugin(timeline: string[]) {
  return () => async () => {
    timeline.push('teardown-start')
    await sleep(TEARDOWN_MS)
    timeline.push('teardown-end')
  }
}

// A removed entry leaves `store` before its teardown settles. Both settle points
// must still wait for it: `await()` (the tree contract) and the update that
// performs the removal.
describe('teardown of removed entries', () => {
  it('await() waits for a removed entry', async () => {
    const { loader } = await boot()
    const timeline: string[] = []
    loader.mock('slow', slowPlugin(timeline))
    const id = await loader.create({ name: 'slow' })
    await loader.await()
    loader.remove(id)
    await loader.await()
    expect(timeline).to.deep.equal(['teardown-start', 'teardown-end'])
  })

  it('updating a group waits for the removals it performs', async () => {
    const { loader } = await boot()
    const timeline: string[] = []
    loader.mock('slow', slowPlugin(timeline))
    await loader.create({ id: 'g', name: GROUP, group: true, config: [{ id: '1', name: 'slow' }] })
    await loader.await()
    const start = Date.now()
    await loader.update('g', { config: [] })
    expect(timeline).to.deep.equal(['teardown-start', 'teardown-end'])
    expect(Date.now() - start).to.be.greaterThanOrEqual(TEARDOWN_MS)
  })
})
