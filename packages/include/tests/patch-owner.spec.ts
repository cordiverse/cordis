import { expect, describe, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import * as yaml from 'js-yaml'
import Include from '../src'
import type { PatchOptions } from '../src/patch'
import { fixture, harness, plugin } from './utils'

describe('Include inserted-entry overrides', () => {
  const { setup } = harness()

  const config = (value: number) => ({ tag: 'x', value })
  const scenarios: { name: string; patches: PatchOptions[]; expected: PatchOptions[]; initial: number }[] = [
    {
      name: 'last override',
      patches: [{ insert: [plugin('x', 1)] }, { id: 'x', config: config(2) }],
      expected: [{ insert: [plugin('x', 1, { disabled: false })] }, { id: 'x', config: config(3) }],
      initial: 2,
    },
    {
      name: 'multiple overrides',
      patches: [{ insert: [plugin('x', 1)] }, { id: 'x', config: config(0) }, { id: 'x', config: config(2) }],
      expected: [{ insert: [plugin('x', 1, { disabled: false })] }, { id: 'x', config: config(0) }, { id: 'x', config: config(3) }],
      initial: 2,
    },
    {
      name: 'insertion without overrides',
      patches: [{ insert: [plugin('x', 1)] }],
      expected: [{ insert: [plugin('x', 3, { disabled: false })] }],
      initial: 1,
    },
    {
      name: 'skipped override before insertion',
      patches: [{ id: 'x', config: config(2) }, { insert: [plugin('x', 1)] }],
      expected: [{ id: 'x', config: config(2) }, { insert: [plugin('x', 3, { disabled: false })] }],
      initial: 1,
    },
    {
      name: 'skipped name mismatch',
      patches: [{ insert: [plugin('x', 1)] }, { id: 'x', config: config(2) }, { id: 'x', name: 'wrong-plugin', config: config(9) }],
      expected: [{ insert: [plugin('x', 1, { disabled: false })] }, { id: 'x', config: config(3) }, { id: 'x', name: 'wrong-plugin', config: config(9) }],
      initial: 2,
    },
  ]

  for (const scenario of scenarios) {
    it(`persists each key to its effective owner (${scenario.name})`, async () => {
      const inner = fixture('tmp-owner-inner.yml')
      const innerText = yaml.dump([plugin('a', 1)])
      await writeFile(inner, innerText)
      const app = await setup('tmp-owner-outer.yml', [{
        id: 'inc',
        name: '@cordisjs/plugin-include',
        config: {
          path: './tmp-owner-inner.yml',
          patches: scenario.patches,
        },
      }])
      app.files.push(inner)
      const include = () => app.include().store['inc']!.subtree as Include
      expect(app.config('x').value).toBe(scenario.initial)

      await app.update('inc:x', { config: config(3), disabled: false })
      await include().refresh()
      await app.settle()

      expect(app.config('x').value).toBe(3)
      const [entry] = await app.read()
      expect(entry.config.patches).toEqual(scenario.expected)
      expect(await readFile(inner, 'utf8')).toBe(innerText)
      expect(app.logs('error')).toEqual([])
    })
  }
})
