import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { fileURLToPath } from 'node:url'
import { Loader, ModuleNotFoundError } from '../src/index.ts'

describe('Loader: plugin import', () => {
  const baseUrl = new URL('./fixtures/', import.meta.url).href
  const frames = () => ['    at a (/app/plugins.yml:1:3)']

  async function setup(message: string) {
    const root = new Context()
    // the service seen from `root` resolves against the caller's base
    root.baseUrl = baseUrl
    await root.plugin(Loader, { baseUrl })
    const loader = root.loader
    // what Node's own loader throws, as the internal loader may not be reachable here
    loader.internal = {
      import: async () => {
        throw Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' })
      },
    } as any
    return loader
  }

  it('keep the hints of Node after the first line', async () => {
    const loader = await setup([
      `Cannot find module '/app/plugin' imported from ${fileURLToPath(baseUrl)}`,
      'Did you mean to import "./plugin.js"?',
    ].join('\n'))

    const error = await loader.import('./plugin', frames).catch(error => error)
    expect(error).toBeInstanceOf(ModuleNotFoundError)
    expect(error.specifier).toBe('./plugin')
    expect(error.message).toBe(`Cannot find module '/app/plugin'\nDid you mean to import "./plugin.js"?`)
    expect(error.stack).toBe([
      `ModuleNotFoundError: Cannot find module '/app/plugin'`,
      'Did you mean to import "./plugin.js"?',
      '    at a (/app/plugins.yml:1:3)',
    ].join('\n'))
  })

  it('leave a module imported by another one to Node', async () => {
    const message = [
      `Cannot find module '/app/dependency' imported from /app/plugin.js`,
      'Did you mean to import "./dependency.js"?',
    ].join('\n')
    const loader = await setup(message)

    const error = await loader.import('./plugin', frames).catch(error => error)
    expect(error).not.toBeInstanceOf(ModuleNotFoundError)
    expect(error.message).toBe(message)
  })
})
