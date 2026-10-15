import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { fixture, harness } from './utils.ts'

/** `file:line:column` of the first occurrence of `needle`, as the loader prints it. */
function at(filename: string, source: string, needle: string) {
  const lines = source.slice(0, source.indexOf(needle)).split('\n')
  return `${relative(process.cwd(), filename)}:${lines.length}:${lines.at(-1)!.length + 1}`
}

describe('Include source locations', () => {
  const { setup } = harness()

  async function start(name: string, source: string) {
    const app = await setup(name, source)
    const stacks = () => app.messages
      .filter(message => message.type === 'error')
      .map(message => message.args[0].stack as string)
    return { ...app, stacks, at: (needle: string) => at(app.filename, source, needle) }
  }

  it('points a validation issue at the value in the file', async () => {
    const app = await start('tmp-location-value.yml', [
      '- id: a',
      '  name: ./schema-plugin',
      '  config:',
      '    port: "80"',
      '',
    ].join('\n'))

    const [stack] = app.stacks()
    expect(stack).toContain([
      'ValidationError: invalid config:',
      '  - port must be a number',
      `    at port (${app.at('"80"')})`,
      '      4 |     port: "80"',
      '        |           ^^^^',
      `    at a (${app.filename}:1:3)`,
    ].join('\n'))
  }, 10000)

  it('points a missing value at the key that should hold it', async () => {
    const app = await start('tmp-location-missing.yml', [
      '- id: a',
      '  name: ./schema-plugin',
      '  config:',
      '    hosts: [localhost, 1]',
      '- id: b',
      '  name: ./schema-plugin',
      '',
    ].join('\n'))

    const stacks = app.stacks()
    expect(stacks.find(stack => stack.includes('at a ('))).toContain([
      '  - port must be a number',
      `    at port (${app.at('config:')})`,
      '      3 |   config:',
      '        |   ^^^^^^',
      '  - host must be a string',
      `    at hosts.1 (${app.at('1]')})`,
    ].join('\n'))
    expect(stacks.find(stack => stack.includes('at b ('))).toContain([
      '  - config is required',
      `    at ${app.at('id: b')}`,
    ].join('\n'))
  }, 10000)

  it('locates entries nested in groups', async () => {
    const app = await start('tmp-location-group.yml', [
      '- id: g',
      '  name: \'@cordisjs/plugin-group\'',
      '  group: true',
      '  config:',
      '    - id: a',
      '      name: ./schema-plugin',
      '      config:',
      '        port: !!js "\'80\'"',
      '',
    ].join('\n'))

    const [stack] = app.stacks()
    expect(stack).toContain(`    at port (${app.at('"\'80\'"')})`)
    expect(stack).toContain(`    at a (${app.filename}:5:7)\n    at g (${app.filename}:1:3)`)
  }, 10000)

  it('locates patched values in the file that declares the patch', async () => {
    const inner = fixture('tmp-location-inner.yml')
    await writeFile(inner, '- id: a\n  name: ./schema-plugin\n  config:\n    port: 80\n')
    const app = await start('tmp-location-outer.yml', [
      '- id: inc',
      '  name: \'@cordisjs/plugin-include\'',
      '  config:',
      '    path: ./tmp-location-inner.yml',
      '    patches:',
      '      - id: a',
      '        config: { port: "80" }',
      '      - insert:',
      '          - id: b',
      '            name: ./schema-plugin',
      '            config: { port: 80, hosts: [1] }',
      '',
    ].join('\n'))
    app.files.push(inner)

    const stacks = app.stacks()
    expect(stacks.find(stack => stack.includes('at a ('))).toContain(`    at port (${app.at('"80"')})`)
    expect(stacks.find(stack => stack.includes('at b ('))).toContain(`    at hosts.0 (${app.at('1]')})`)
  }, 10000)

  it('leaves a config passed at runtime unlocated', async () => {
    const app = await start('tmp-location-runtime.yml', '- id: a\n  name: ./schema-plugin\n  config:\n    port: 80\n')
    const fiber = app.include().store['a']!.fiber!
    expect(() => fiber.update({ port: 'runtime' })).toThrow(/^invalid config:\n {2}- port must be a number \(at port\)$/)
  }, 10000)

  it('keeps the plain format for entries outside any file', async () => {
    const app = await start('tmp-location-memory.yml', '[]\n')
    await app.ctx.loader.create({ name: './fixtures/schema-plugin', config: { port: '80' } })
    await app.ctx.loader.await()
    expect(app.stacks()).toEqual([expect.stringContaining('invalid config:\n  - port must be a number (at port)\n    at file:')])
  }, 10000)

  it('points parse errors at the source', async () => {
    const app = await start('tmp-location-parse.yml', '[]\n')
    const source = '- id: a\n  name: !foo ./schema-plugin\n'
    await writeFile(app.filename, source)
    await app.settle()

    expect(app.logs('warn')).toEqual([expect.stringContaining([
      '  - Unresolved tag: !foo',
      `    at ${at(app.filename, source, '!foo')}`,
      '      2 |   name: !foo ./schema-plugin',
      '        |         ^^^^',
    ].join('\n'))])
  }, 10000)

  it('writes expressions back with their tag', async () => {
    const app = await start('tmp-location-expr.yml', '- id: a\n  name: ./config-plugin\n  config:\n    tag: a\n    value: !!js "\'#\' + 1"\n')
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
