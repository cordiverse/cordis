import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { fixture, harness } from './utils.ts'

/** `file:line:column` of the first occurrence of `needle`, as the loader prints it. */
function at(filename: string, source: string, needle: string) {
  const lines = source.slice(0, source.indexOf(needle)).split('\n')
  return `${filename}:${lines.length}:${lines.at(-1)!.length + 1}`
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
      `  - port must be a number (at port, ${app.at('"80"')})`,
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
      `  - port must be a number (at port, ${app.at('config:')})`,
      `  - host must be a string (at hosts.1, ${app.at('1]')})`,
    ].join('\n'))
    expect(stacks.find(stack => stack.includes('at b ('))).toContain(`  - config is required (at ${app.at('id: b')})`)
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
    expect(stack).toContain(`  - port must be a number (at port, ${app.at('"\'80\'"')})`)
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
    expect(stacks.find(stack => stack.includes('at a ('))).toContain(`(at port, ${app.at('"80"')})`)
    expect(stacks.find(stack => stack.includes('at b ('))).toContain(`(at hosts.0, ${app.at('1]')})`)
  }, 10000)

  it('locates overrides of inserted entries in the override', async () => {
    const inner = fixture('tmp-location-insert-inner.yml')
    await writeFile(inner, '[]\n')
    const app = await start('tmp-location-insert-outer.yml', [
      '- id: inc',
      '  name: \'@cordisjs/plugin-include\'',
      '  config:',
      '    path: ./tmp-location-insert-inner.yml',
      '    patches:',
      '      - insert:',
      '          - id: a',
      '            name: ./schema-plugin',
      '            config: { port: 80 }',
      '      - id: a',
      '        config: { port: "80" }',
      '',
    ].join('\n'))
    app.files.push(inner)

    expect(app.stacks()).toEqual([expect.stringContaining(`(at port, ${app.at('"80"')})`)])
  }, 10000)

  it('locates entries of a group config replaced by a patch', async () => {
    const inner = fixture('tmp-location-group-inner.yml')
    await writeFile(inner, '- id: g\n  name: \'@cordisjs/plugin-group\'\n  group: true\n  config: []\n')
    const app = await start('tmp-location-group-outer.yml', [
      '- id: inc',
      '  name: \'@cordisjs/plugin-include\'',
      '  config:',
      '    path: ./tmp-location-group-inner.yml',
      '    patches:',
      '      - id: g',
      '        config:',
      '          - id: a',
      '            name: ./schema-plugin',
      '            config: { port: "80" }',
      '',
    ].join('\n'))
    app.files.push(inner)

    const [stack] = app.stacks()
    expect(stack).toContain(`(at port, ${app.at('"80"')})`)
    expect(stack).toContain(`    at a (${app.filename}:8:13)\n    at g (${inner}:1:3)`)
  }, 10000)

  it('ignores patches that do not apply', async () => {
    const inner = fixture('tmp-location-skip-inner.yml')
    await writeFile(inner, '- id: a\n  name: ./schema-plugin\n  config: { port: "80" }\n')
    const app = await start('tmp-location-skip-outer.yml', [
      '- id: inc',
      '  name: \'@cordisjs/plugin-include\'',
      '  config:',
      '    path: ./tmp-location-skip-inner.yml',
      '    patches:',
      '      - id: a',
      '        name: ./other-plugin',
      '        config: { port: 80 }',
      '',
    ].join('\n'))
    app.files.push(inner)

    expect(app.stacks()).toEqual([expect.stringContaining(`(at port, ${inner}:3:19)`)])
  }, 10000)

  it('follows patches across nested includes', async () => {
    const inner = fixture('tmp-location-nested-inner.yml')
    const middle = fixture('tmp-location-nested-middle.yml')
    await writeFile(inner, '- id: a\n  name: ./schema-plugin\n  config: { port: 80 }\n')
    await writeFile(middle, [
      '- id: inc',
      '  name: \'@cordisjs/plugin-include\'',
      '  config:',
      '    path: ./tmp-location-nested-inner.yml',
      '    patches:',
      '      - id: a',
      '        config: { port: "middle" }',
      '',
    ].join('\n'))
    // the outer patch replaces the whole config of `inc`, its patches included
    const app = await start('tmp-location-nested-outer.yml', [
      '- id: mid',
      '  name: \'@cordisjs/plugin-include\'',
      '  config:',
      '    path: ./tmp-location-nested-middle.yml',
      '    patches:',
      '      - id: inc',
      '        config:',
      '          path: ./tmp-location-nested-inner.yml',
      '          patches:',
      '            - id: a',
      '              config: { port: "outer" }',
      '',
    ].join('\n'))
    app.files.push(inner, middle)

    const [stack] = app.stacks()
    expect(stack).toContain(`(at port, ${app.at('"outer"')})`)
    expect(stack).toContain([
      `    at a (${inner}:1:3)`,
      `    at inc (${middle}:1:3)`,
      `    at mid (${app.filename}:1:3)`,
    ].join('\n'))
  }, 10000)

  it('leaves a config passed at runtime unlocated', async () => {
    const app = await start('tmp-location-runtime.yml', '- id: a\n  name: ./schema-plugin\n  config:\n    port: 80\n')
    const fiber = app.include().store['a']!.fiber!
    expect(() => fiber.update({ port: 'runtime' })).toThrow(/^invalid config:\n {2}- port must be a number \(at port\)$/)
  }, 10000)

  it('leaves entries outside any file untraced', async () => {
    const app = await start('tmp-location-memory.yml', '[]\n')
    await app.ctx.loader.create({ name: './fixtures/schema-plugin', config: { port: '80' } })
    await app.ctx.loader.await()
    const [stack] = app.stacks()
    expect(stack).toMatch(/^ValidationError: invalid config:\n {2}- port must be a number \(at port\)\n {4}at /)
    expect(stack).not.toContain('#')
  }, 10000)

  describe('entry fields', () => {
    it('points invalid fields at their values', async () => {
      const app = await start('tmp-location-fields.yml', [
        '- id: a',
        '  name: ./test-plugin',
        '  disabled: "no"',
        '  inject: [loader, 1]',
        '- id: b',
        '  group: true',
        '',
      ].join('\n'))

      const stacks = app.stacks()
      expect(stacks).toHaveLength(2)
      expect(stacks.find(stack => stack.includes('at a ('))).toBe([
        'EntryValidationError: invalid entry options:',
        `  - disabled must be a boolean (at disabled, ${app.at('"no"')})`,
        `  - inject.1 must be a string (at inject.1, ${app.at('1]')})`,
        `    at a (${app.filename}:1:3)`,
      ].join('\n'))
      // a missing field falls back to the entry
      expect(stacks.find(stack => stack.includes('at b ('))).toContain([
        `  - name is required (at name, ${app.at('id: b')})`,
        `  - config is required (at config, ${app.at('id: b')})`,
      ].join('\n'))
      expect(app.include().store['a']).toBeUndefined()
    }, 10000)

    it('accepts an expression for disabled only', async () => {
      const app = await start('tmp-location-expr.yml', [
        '- id: a',
        '  name: ./test-plugin',
        '  disabled: !!js "false"',
        '- id: b',
        '  name: !!js "\'./test-plugin\'"',
        '',
      ].join('\n'))

      expect(app.stacks()).toEqual([expect.stringContaining(`  - name must be a string (at name, ${app.at('"\'./')})`)])
      expect(app.include().store['a']!.fiber).toBeTruthy()
    }, 10000)

    it('unloads an entry that turns invalid, without writing to the file', async () => {
      const source = '- id: a\n  name: ./test-plugin\n'
      const app = await start('tmp-location-turn.yml', source)
      const fiber = app.include().store['a']!.fiber!

      const invalid = '- id: a\n  name: ./test-plugin\n  group: 1\n'
      await writeFile(app.filename, invalid)
      await app.settle()
      expect(app.stacks()).toEqual([expect.stringContaining(`(at group, ${at(app.filename, invalid, '1\n')})`)])
      expect(app.include().store['a']).toBeUndefined()
      expect(fiber.uid).toBeNull()
      expect(await app.text()).toBe(invalid)

      await writeFile(app.filename, source)
      await app.settle()
      expect(app.include().store['a']!.fiber!.uid).toBeTruthy()
    }, 10000)

    it('locates entries nested in groups', async () => {
      const app = await start('tmp-location-fields-group.yml', [
        '- id: g',
        '  name: \'@cordisjs/plugin-group\'',
        '  group: true',
        '  config:',
        '    - id: a',
        '      name: [./test-plugin]',
        '',
      ].join('\n'))

      expect(app.stacks()).toEqual([[
        'EntryValidationError: invalid entry options:',
        `  - name must be a string (at name, ${app.at('name: [')})`,
        `    at a (${app.filename}:5:7)`,
        `    at g (${app.filename}:1:3)`,
      ].join('\n')])
    }, 10000)

    it('rejects a file with an entry that is not an object', async () => {
      const source = '- id: a\n  name: ./test-plugin\n'
      const app = await start('tmp-location-entry.yml', source)
      const invalid = [
        '- id: a',
        '  name: ./test-plugin',
        '- ./test-plugin',
        '- id: g',
        '  name: \'@cordisjs/plugin-group\'',
        '  group: true',
        '  config: [null]',
        '',
      ].join('\n')
      await writeFile(app.filename, invalid)
      await app.settle()

      expect(app.logs('warn')).toEqual([expect.stringContaining([
        `  - entry must be an object (at ${app.filename}:3:3)`,
        `  - entry must be an object (at ${at(app.filename, invalid, 'null')})`,
      ].join('\n'))])
      // the previous tree stays as it was
      expect(app.include().store['a']!.fiber!.uid).toBeTruthy()
      expect(app.include().store['g']).toBeUndefined()
    }, 10000)

    it('leaves invalid options passed at runtime unlocated', async () => {
      const app = await start('tmp-location-fields-runtime.yml', '- id: a\n  name: ./test-plugin\n')
      await expect(app.update('a', { disabled: 'yes' })).rejects.toThrow(
        /^invalid entry options:\n {2}- disabled must be a boolean \(at disabled\)$/,
      )
    }, 10000)
  })

  describe('plugin import', () => {
    it('points a plugin that cannot be found at its name', async () => {
      const app = await start('tmp-location-import.yml', [
        '- id: a',
        '  name: ./missing-plugin',
        '- id: b',
        '  name: missing-package',
        '',
      ].join('\n'))

      const stacks = app.stacks()
      expect(stacks).toHaveLength(2)
      const a = stacks.find(stack => stack.includes('at a ('))!
      // the loader's own parent and Node's resolver frames are dropped
      expect(a).toMatch(new RegExp(`^ModuleNotFoundError: Cannot find module '\\S+missing-plugin' \\(at name, ${app.at('./missing')}\\)\n`))
      expect(a).toContain(`\n    at a (${app.filename}:1:3)`)
      expect(a).not.toContain('imported from')
      expect(a).not.toContain('node:internal')
      const b = stacks.find(stack => stack.includes('at b ('))!
      expect(b).toBe([
        `ModuleNotFoundError: Cannot find package 'missing-package' (at name, ${app.at('missing-package')})`,
        `    at b (${app.filename}:3:3)`,
      ].join('\n'))
      const errors = app.messages.filter(message => message.type === 'error').map(message => message.args[0])
      expect(errors.map(error => [error.code, error.specifier])).toEqual(expect.arrayContaining([
        ['ERR_MODULE_NOT_FOUND', './missing-plugin'],
        ['ERR_MODULE_NOT_FOUND', 'missing-package'],
      ]))
    }, 10000)

    it('leaves a module the plugin imports to the plugin', async () => {
      const app = await start('tmp-location-dep.yml', '- id: a\n  name: ./missing-dep-plugin\n')

      const [stack] = app.stacks()
      expect(stack).toMatch(/^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find package 'missing-dependency' imported from .+missing-dep-plugin\.ts\n/)
      expect(stack).not.toContain('(at name')
    }, 10000)

    it('tells the two apart without the internal loader', async () => {
      const app = await start('tmp-location-native.yml', '[]\n')
      const { loader } = app.ctx
      const internal = loader.internal
      loader.internal = undefined
      try {
        const source = [
          '- id: a',
          '  name: ./missing-plugin',
          '- id: b',
          '  name: missing-package',
          '- id: c',
          '  name: ./missing-dep-plugin',
          '',
        ].join('\n')
        await writeFile(app.filename, source)
        await app.settle()

        const stacks = app.stacks()
        expect(stacks).toHaveLength(3)
        expect(stacks.find(stack => stack.includes('at a ('))).toContain(`(at name, ${at(app.filename, source, './missing-plugin')})`)
        expect(stacks.find(stack => stack.includes('at b ('))).toContain(`(at name, ${at(app.filename, source, 'missing-package')})`)
        const dependency = stacks.find(stack => stack.includes('missing-dependency'))
        expect(dependency).toMatch(/^Error \[ERR_MODULE_NOT_FOUND\]: /)
        expect(dependency).not.toContain('(at name')
      } finally {
        loader.internal = internal
      }
    }, 10000)

    it('leaves other import errors to point into the plugin', async () => {
      const app = await start('tmp-location-throw.yml', '- id: a\n  name: ./throw-plugin\n')

      const [stack] = app.stacks()
      expect(stack).toMatch(/^Error: failed to evaluate\n/)
      expect(stack).toContain('throw-plugin.ts')
      expect(stack).not.toContain('(at name')
    }, 10000)

    it('leaves entries outside any file untraced', async () => {
      const app = await start('tmp-location-import-memory.yml', '[]\n')
      await app.ctx.loader.create({ name: './fixtures/missing-plugin' })
      await app.ctx.loader.await()
      const [stack] = app.stacks()
      expect(stack).toMatch(/^ModuleNotFoundError: Cannot find module '\S+missing-plugin'\n/)
      expect(stack).not.toContain('(at name')
    }, 10000)
  })

  it('points parse errors at the source', async () => {
    const app = await start('tmp-location-parse.yml', '[]\n')
    const source = '- id: a\n  name: !foo ./schema-plugin\n'
    await writeFile(app.filename, source)
    await app.settle()

    expect(app.logs('warn')).toEqual([expect.stringContaining(
      `  - Unresolved tag: !foo (at ${at(app.filename, source, '!foo')})`,
    )])
  }, 10000)

  describe('JSON', () => {
    it('points a validation issue at the value in the file', async () => {
      const app = await start('tmp-location-value.json', JSON.stringify([
        { id: 'a', name: './schema-plugin', config: { port: '80' } },
      ], null, 2))

      const [stack] = app.stacks()
      expect(stack).toContain([
        'ValidationError: invalid config:',
        `  - port must be a number (at port, ${app.at('"80"')})`,
        `    at a (${app.at('{\n    "id"')})`,
      ].join('\n'))
    }, 10000)

    it('points syntax errors at the source', async () => {
      const app = await start('tmp-location-syntax.json', '[]\n')
      const source = '[\n  { "id": "a", }\n]\n'
      await writeFile(app.filename, source)
      await app.settle()

      const [message] = app.logs('warn')
      expect(message).toContain(`(at ${at(app.filename, source, '}\n]')})`)
      expect(message).not.toContain('at position')
    }, 10000)

    it('points a non-array file at its value', async () => {
      const app = await start('tmp-location-shape.json', '[]\n')
      const source = '\n{ "id": "a" }\n'
      await writeFile(app.filename, source)
      await app.settle()

      expect(app.logs('warn')).toEqual([expect.stringContaining(
        `  - config file must be a top-level array (at ${at(app.filename, source, '{')})`,
      )])
    }, 10000)
  })
})
