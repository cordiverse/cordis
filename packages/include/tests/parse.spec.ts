import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { harness } from './utils.ts'

describe('Include parse', () => {
  const { setup } = harness()

  // scalars resolve by the YAML 1.2 core schema, whatever version the file declares
  it.each(['', '%YAML 1.1\n---\n'])('resolves scalars by the core schema (%j)', async (directive) => {
    const values = ['yes', 'on', 'n', '2024-01-01', '2024-01-01T12:00:00Z', '1_000', '1:30', '0777', '0o17', '0x1F', '0b101', '-0b11', '~', 'True', '.inf']
    const app = await setup('tmp-parse-scalars.yml', directive + [
      '- id: a',
      '  name: ./config-plugin',
      '  config:',
      '    tag: a',
      '    value:',
      ...values.map(value => `      - ${value}`),
      '    <<: { merged: true }',
      '',
    ].join('\n'))

    const config = app.config('a')
    expect(config.value).toEqual([
      'yes', 'on', 'n', '2024-01-01', '2024-01-01T12:00:00Z', '1_000', '1:30',
      777, 15, 31, '0b101', '-0b11', null, true, Infinity,
    ])
    expect(config['<<']).toEqual({ merged: true })
    expect(config.merged).toBeUndefined()
  }, 10000)

  it('quotes strings that would read back as other scalars', async () => {
    const app = await setup('tmp-parse-quote.yml', [])
    await app.ctx.loader.create({ name: './config-plugin', config: { tag: 'a', value: ['true', '12'] } }, app.id)
    await app.include().flush()

    expect((await app.text())).toContain(`    value:\n      - 'true'\n      - '12'\n`)
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
