import { expect, describe, it } from 'vitest'
import { findInternalLoader } from '../src/internal.ts'

// Both outcomes are reachable here because the routes are parameters: a process
// either has `--expose-internals` or it does not, and a test that waits for one of
// them to happen by itself can only assert the branch it landed in.
describe('findInternalLoader', () => {
  it('reaches the running loader, or says why it could not', () => {
    const { loader, reason } = findInternalLoader()
    if (loader) {
      // a reachable loader must not carry a reason
      expect(reason).to.be.undefined
    } else {
      // the message is what a user reads when HMR degrades to config reloading
      expect(reason).to.be.a('string')
    }
  })

  it('reports the loader when a route answers with one', () => {
    const loader = { import: async () => ({}) }
    const { loader: found, reason } = findInternalLoader(
      () => ({ getOrInitializeCascadedLoader: () => loader }),
      ['--expose-internals'],
    )
    expect(found).to.equal(loader)
    expect(reason).to.be.undefined
  })

  it('names the missing argument instead of trying only the addon', () => {
    const { loader, reason } = findInternalLoader(() => {
      throw new Error('MODULE_NOT_FOUND: Cannot find module\nrequire stack: …')
    }, [])
    expect(loader).to.be.undefined
    // both routes are tried, and a missing `--expose-internals` is itself an answer
    expect(reason).to.include('--expose-internals is not among the process arguments')
    expect(reason).to.include('node-addon-require-builtin')
    // only the first line of each error: `MODULE_NOT_FOUND` appends a require stack
    expect(reason).to.not.include('require stack')
  })

  it('keeps no state between lookups', () => {
    // a module-level slot would answer for whichever `Loader` was constructed last
    const first = findInternalLoader(() => {
      throw new Error('boom')
    }, [])
    // the addon route reaches the module as `require(id).requireBuiltin(id)`, so the
    // stand-in has to answer that shape and not only the module itself
    const loader = { import: async () => ({}) }
    const second = findInternalLoader(() => ({
      requireBuiltin: () => ({ getOrInitializeCascadedLoader: () => loader }),
    }), [])
    expect(first.reason).to.be.a('string')
    expect(second.loader).to.equal(loader)
    expect(second.reason).to.be.undefined
  })

  it('says so when the module answers but carries no loader', () => {
    const { loader, reason } = findInternalLoader(() => ({}), ['--expose-internals'])
    expect(loader).to.be.undefined
    expect(reason).to.include('has no getOrInitializeCascadedLoader()')
  })

  // Node takes either spelling on the command line, and `process.execArgv` keeps the
  // one that was typed. A check for one spelling sends the other down the addon route,
  // whose failure then reads as the reason.
  it('accepts either spelling of the flag', () => {
    const reached: string[] = []
    const { loader } = findInternalLoader((id) => {
      reached.push(id)
      return { getOrInitializeCascadedLoader: () => ({ import: async () => ({}) }) }
    }, ['--expose_internals'])
    expect(loader).to.be.an('object')
    expect(reached).to.deep.equal(['internal/modules/esm/loader'])
  })
})
