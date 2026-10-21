import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { harness } from './utils.ts'

describe('Include parse', () => {
  const { setup } = harness()

  // a 1.1 directive would read these as `true`, 511, 5 and a merge
  it('resolves scalars by the core schema whatever version the file declares', async () => {
    const app = await setup('tmp-parse-scalars.yml', [
      '%YAML 1.1',
      '---',
      '- id: a',
      '  name: ./config-plugin',
      '  config:',
      '    tag: a',
      '    value: [yes, 0777, 0b101]',
      '    <<: { merged: true }',
      '',
    ].join('\n'))

    const config = app.config('a')
    expect(config.value).toEqual(['yes', 777, '0b101'])
    expect(config['<<']).toEqual({ merged: true })
  }, 10000)

  it('writes expressions back with their tag', async () => {
    const app = await setup('tmp-parse-expr.yml', '- id: a\n  name: ./config-plugin\n  config:\n    tag: a\n    value: !!js "\'#\' + 1"\n')
    expect(app.config('a').value).toBe('#1')

    await app.update('a', { config: { tag: 'a', value: { __jsExpr: "'#' + 2" } } })
    await app.include().flush()
    const text = await app.text()
    expect(text).toContain(`    value: !!js "'#' + 2"\n`)

    // force a re-read of what was written
    await writeFile(app.filename, text + '# touched\n')
    await app.settle()
    expect(app.config('a').value).toBe('#2')
  }, 10000)
})
