import { Context } from 'cordis'
import { expect } from 'chai'
import CLI, { Command } from '../src/index.ts'
import { Input } from '../src/parser.ts'

let ctx: Context
let cli: CLI

before(async () => {
  ctx = new Context()
  ctx.plugin(CLI)
  // wait for service to be ready
  await new Promise(r => setTimeout(r, 100))
  cli = ctx.cli
})

describe('CLI Service', () => {
  describe('builtin types', () => {
    it('should have string type', () => {
      const type = cli._builtin['string']!
      expect(type.parse('hello')).to.equal('hello')
    })

    it('should have text type (greedy)', () => {
      const type = cli._builtin['text']!
      expect(type.greedy).to.be.true
      expect(type.parse('hello world')).to.equal('hello world')
    })

    it('should have boolean type', () => {
      const type = cli._builtin['boolean']!
      expect(type.parse('')).to.be.true
    })

    it('should have number type', () => {
      const type = cli._builtin['number']!
      expect(type.parse('42')).to.equal(42)
      expect(type.parse('-3.14')).to.equal(-3.14)
      expect(type.numeric).to.be.true
      expect(() => type.parse('abc')).to.throw()
    })

    it('should have integer type', () => {
      const type = cli._builtin['integer']!
      expect(type.parse('42')).to.equal(42)
      expect(type.parse('-5')).to.equal(-5)
      expect(() => type.parse('3.14')).to.throw()
      expect(() => type.parse('abc')).to.throw()
    })

    it('should have posint type', () => {
      const type = cli._builtin['posint']!
      expect(type.parse('1')).to.equal(1)
      expect(() => type.parse('0')).to.throw()
      expect(() => type.parse('-1')).to.throw()
    })

    it('should have natural type', () => {
      const type = cli._builtin['natural']!
      expect(type.parse('0')).to.equal(0)
      expect(type.parse('1')).to.equal(1)
      expect(() => type.parse('-1')).to.throw()
    })

    it('should have date type', () => {
      const type = cli._builtin['date']!
      const result = type.parse('2026-01-01')
      expect(result).to.be.instanceOf(Date)
    })
  })

  describe('custom types', () => {
    it('should define and dispose custom types', () => {
      const dispose = cli.define('string', (s) => s.toUpperCase())
      expect(cli._builtin['string']!.parse('hello')).to.equal('HELLO')
      dispose()
      // after dispose, string type should be removed
      expect(cli._builtin['string']).to.be.undefined
    })
  })

  describe('parseType', () => {
    it('should handle regex type', () => {
      const type = cli.parseType(/^\d+$/)
      expect(type.parse('123')).to.equal('123')
      expect(() => type.parse('abc')).to.throw()
    })

    it('should handle array type (enum)', () => {
      const type = cli.parseType(['foo', 'bar', 'baz'] as const)
      expect(type.parse('foo')).to.equal('foo')
      expect(() => type.parse('qux')).to.throw()
    })

    it('should handle function type', () => {
      const type = cli.parseType((s: string) => parseInt(s))
      expect(type.parse('42')).to.equal(42)
    })

    it('should handle undefined (default to string)', () => {
      const type = cli.parseType(undefined)
      expect(type.parse('hello')).to.equal('hello')
    })
  })
})

describe('Command Registration', () => {
  it('should register a command', () => {
    const cmd = cli.command('test-reg-1')
    expect(cli._aliases['test-reg-1']).to.exist
    cmd.dispose()
  })

  it('should hyphenate command name', () => {
    const cmd = cli.command('fooBar')
    expect(cli._aliases['foo-bar']).to.exist
    cmd.dispose()
  })

  it('should register command with arguments', () => {
    const cmd = cli.command('greet <name> [greeting]')
    expect(cmd._arguments).to.have.length(2)
    expect(cmd._arguments[0].name).to.equal('name')
    expect(cmd._arguments[0].required).to.be.true
    expect(cmd._arguments[1].name).to.equal('greeting')
    expect(cmd._arguments[1].required).to.be.false
    cmd.dispose()
  })

  it('should register variadic arguments', () => {
    const cmd = cli.command('echo [...messages]')
    expect(cmd._arguments).to.have.length(1)
    expect(cmd._arguments[0].variadic).to.be.true
    cmd.dispose()
  })

  it('should register typed arguments', () => {
    const cmd = cli.command('add <a:number> <b:number>')
    expect(cmd._arguments).to.have.length(2)
    expect(cmd._arguments[0].numeric).to.be.true
    cmd.dispose()
  })
})

describe('Command Options', () => {
  let cmd: Command

  beforeEach(() => {
    cmd = cli.command('opt-test <foo>')
  })

  afterEach(() => {
    cmd.dispose()
  })

  it('should register boolean option', () => {
    cmd.option('-v, --verbose')
    expect(cmd._optionDict['verbose']).to.exist
    expect(cmd._optionDict['v']).to.exist
  })

  it('should register option with argument', () => {
    cmd.option('-o, --output <path>')
    const opt = cmd._optionDict['output']!
    expect(opt.param).to.exist
    expect(opt.param!.name).to.equal('path')
  })

  it('should register typed option', () => {
    cmd.option('-n, --count <n:number>')
    const opt = cmd._optionDict['count']!
    expect(opt.param!.numeric).to.be.true
  })

  it('should register option with explicit type', () => {
    cmd.option('-p, --port <port>', { type: 'number' })
    const opt = cmd._optionDict['port']!
    expect(opt.param!.numeric).to.be.true
  })

  it('should reject duplicate options', () => {
    cmd.option('-v, --verbose')
    expect(() => cmd.option('-v')).to.throw('duplicate option')
  })

  it('should reject invalid short option (multi-char with single dash)', () => {
    expect(() => cmd.option('-verbose')).to.throw('invalid option name')
  })

  it('should reject option with multiple arguments', () => {
    expect(() => cmd.option('--range <start> <end>')).to.throw('option accepts at most one argument')
  })

  it('should require argument for typed option', () => {
    expect(() => cmd.option('--verbose', { type: 'number' })).to.throw('option with type requires argument')
  })

  it('should register option with default', () => {
    cmd.option('-p, --port <port:number>', { default: 8080 })
    const opt = cmd._optionDict['port']!
    expect(opt.default).to.equal(8080)
  })
})

describe('Command Parsing', () => {
  describe('basic arguments', () => {
    it('should parse required arguments', () => {
      const cmd = cli.command('parse-test-1 <name>')
      const input = new Input.String('hello')
      const { args } = cmd.parse(input)
      expect(args).to.deep.equal(['hello'])
      cmd.dispose()
    })

    it('should parse optional arguments', () => {
      const cmd = cli.command('parse-test-2 [name]')
      const input = new Input.String('world')
      const { args } = cmd.parse(input)
      expect(args).to.deep.equal(['world'])
      cmd.dispose()
    })

    it('should parse multiple arguments', () => {
      const cmd = cli.command('parse-test-3 <src> <dst>')
      const input = new Input.String('a.txt b.txt')
      const { args } = cmd.parse(input)
      expect(args).to.deep.equal(['a.txt', 'b.txt'])
      cmd.dispose()
    })

    it('should parse typed arguments', () => {
      const cmd = cli.command('parse-test-4 <a:number> <b:number>')
      const input = new Input.String('3 4')
      const { args } = cmd.parse(input)
      expect(args).to.deep.equal([3, 4])
      cmd.dispose()
    })

    it('should parse variadic arguments', () => {
      const cmd = cli.command('parse-test-5 [...msgs]')
      const input = new Input.String('a b c')
      const { args } = cmd.parse(input)
      expect(args).to.deep.equal(['a', 'b', 'c'])
      cmd.dispose()
    })

    it('should throw on missing required arguments', () => {
      const cmd = cli.command('parse-test-6 <a> <b>')
      const input = new Input.String('only-one')
      expect(() => cmd.parse(input)).to.throw('missing arguments')
      cmd.dispose()
    })
  })

  describe('option parsing', () => {
    it('should parse long boolean option', () => {
      const cmd = cli.command('opt-parse-1')
      cmd.option('--verbose')
      const input = new Input.String('--verbose')
      const { options } = cmd.parse(input)
      expect(options['verbose']).to.be.true
      cmd.dispose()
    })

    it('should parse short boolean option', () => {
      const cmd = cli.command('opt-parse-2')
      cmd.option('-v, --verbose')
      const input = new Input.String('-v')
      const { options } = cmd.parse(input)
      expect(options['verbose']).to.be.true
      cmd.dispose()
    })

    it('should parse option with value', () => {
      const cmd = cli.command('opt-parse-3')
      cmd.option('-o, --output <path>')
      const input = new Input.String('--output /tmp/out')
      const { options } = cmd.parse(input)
      expect(options['output']).to.equal('/tmp/out')
      cmd.dispose()
    })

    it('should parse option with = syntax', () => {
      const cmd = cli.command('opt-parse-4')
      cmd.option('-o, --output <path>')
      const input = new Input.String('--output=/tmp/out')
      const { options } = cmd.parse(input)
      expect(options['output']).to.equal('/tmp/out')
      cmd.dispose()
    })

    it('should parse typed option', () => {
      const cmd = cli.command('opt-parse-5')
      cmd.option('-p, --port <port:number>')
      const input = new Input.String('--port 3000')
      const { options } = cmd.parse(input)
      expect(options['port']).to.equal(3000)
      cmd.dispose()
    })

    it('should apply default values', () => {
      const cmd = cli.command('opt-parse-6')
      cmd.option('-p, --port <port:number>', { default: 8080 })
      const input = new Input.String('')
      const { options } = cmd.parse(input)
      expect(options['port']).to.equal(8080)
      cmd.dispose()
    })

    it('should parse combined short options', () => {
      const cmd = cli.command('opt-parse-7')
      cmd.option('-a, --alpha')
      cmd.option('-b, --beta <val:number>')
      const input = new Input.String('-ab 42')
      const { options } = cmd.parse(input)
      expect(options['alpha']).to.be.true
      expect(options['beta']).to.equal(42)
      cmd.dispose()
    })

    it('should parse combined short options with =', () => {
      const cmd = cli.command('opt-parse-8')
      cmd.option('-a, --alpha')
      cmd.option('-b, --beta <val:number>')
      const input = new Input.String('-ab=42')
      const { options } = cmd.parse(input)
      expect(options['alpha']).to.be.true
      expect(options['beta']).to.equal(42)
      cmd.dispose()
    })

    it('should throw on unknown option (default)', () => {
      const cmd = cli.command('opt-parse-9')
      const input = new Input.String('--foo')
      expect(() => cmd.parse(input)).to.throw('unknown option')
      cmd.dispose()
    })

    it('should allow unknown options when configured', () => {
      const cmd = cli.command('opt-parse-10', { unknownOption: 'allow' })
      const input = new Input.String('--foo bar')
      const { options } = cmd.parse(input)
      expect(options['foo']).to.equal('bar')
      cmd.dispose()
    })

    it('should throw on missing required options', () => {
      const cmd = cli.command('opt-parse-11')
      cmd.option('--name <name>')
      const input = new Input.String('')
      expect(() => cmd.parse(input)).to.throw('missing options')
      cmd.dispose()
    })

    it('should parse greedy option', () => {
      const cmd = cli.command('opt-parse-12')
      cmd.option('--message <msg:text>')
      const input = new Input.String('--message hello world')
      const { options } = cmd.parse(input)
      expect(options['message']).to.equal('hello world')
      cmd.dispose()
    })

    it('should parse variadic option', () => {
      const cmd = cli.command('opt-parse-13')
      cmd.option('--tags <...tag>')
      const input = new Input.String('--tags a --tags b')
      const { options } = cmd.parse(input)
      expect(options['tags']).to.deep.equal(['a', 'b'])
      cmd.dispose()
    })
  })

  describe('mixed arguments and options', () => {
    it('should parse args before options', () => {
      const cmd = cli.command('mixed-1 <file>')
      cmd.option('-v, --verbose')
      const input = new Input.String('foo.txt -v')
      const { args, options } = cmd.parse(input)
      expect(args).to.deep.equal(['foo.txt'])
      expect(options['verbose']).to.be.true
      cmd.dispose()
    })

    it('should parse options before args', () => {
      const cmd = cli.command('mixed-2 <file>')
      cmd.option('-v, --verbose')
      const input = new Input.String('-v foo.txt')
      const { args, options } = cmd.parse(input)
      expect(args).to.deep.equal(['foo.txt'])
      expect(options['verbose']).to.be.true
      cmd.dispose()
    })

    it('negative numbers should not be treated as options', () => {
      const cmd = cli.command('mixed-3 <num:number>')
      const input = new Input.String('-5')
      const { args } = cmd.parse(input)
      expect(args).to.deep.equal([-5])
      cmd.dispose()
    })
  })
})

describe('Command Aliases', () => {
  it('should register aliases', () => {
    const cmd = cli.command('install-test')
    cmd.alias('i-test', {})
    expect(cli._aliases['i-test']).to.exist
    expect(cli._aliases['install-test']).to.exist
    cmd.dispose()
  })

  it('should support alias with preset args/options', () => {
    const cmd = cli.command('alias-test-2')
    cmd.alias('at2', { args: ['--save'] })
    expect(cmd._aliases['at2']).to.deep.equal({ args: ['--save'] })
    cmd.dispose()
  })

  it('dot-prefixed aliases should not register globally', () => {
    const cmd = cli.command('alias-test-3')
    cmd.alias('.hidden', {})
    expect(cli._aliases['.hidden']).to.be.undefined
    expect(cmd._aliases['.hidden']).to.exist
    cmd.dispose()
  })

  it('should clean up aliases on dispose', () => {
    const cmd = cli.command('alias-test-4')
    cmd.alias('at4', {})
    expect(cli._aliases['at4']).to.exist
    cmd.dispose()
    expect(cli._aliases['at4']).to.be.undefined
    expect(cli._aliases['alias-test-4']).to.be.undefined
  })
})

describe('Command Execution', () => {
  it('should execute action', async () => {
    const cmd = cli.command('exec-1 <name>')
    cmd.action((argv) => `Hello, ${argv.args[0]}!`)
    const input = new Input.String('exec-1 world')
    const result = await cli.execute(input)
    expect(result).to.equal('Hello, world!')
    cmd.dispose()
  })

  it('should pass options to action', async () => {
    const cmd = cli.command('exec-2 <name>')
    cmd.option('-l, --loud')
    cmd.action((argv) => {
      const name = argv.args[0] as string
      return argv.options['loud'] ? name.toUpperCase() : name
    })
    const input = new Input.String('exec-2 alice --loud')
    const result = await cli.execute(input)
    expect(result).to.equal('ALICE')
    cmd.dispose()
  })

  it('should throw on empty input', () => {
    const input = new Input.String('')
    expect(() => cli.execute(input)).to.throw('no command provided')
  })

  it('should throw on unknown command', () => {
    const input = new Input.String('nonexistent')
    expect(() => cli.execute(input)).to.throw('command "nonexistent" not found')
  })

  it('should return undefined when no action', async () => {
    const cmd = cli.command('exec-noop')
    const input = new Input.String('exec-noop')
    const result = await cli.execute(input)
    expect(result).to.be.undefined
    cmd.dispose()
  })

  it('should support async actions', async () => {
    const cmd = cli.command('exec-async')
    cmd.action(async () => {
      await new Promise(r => setTimeout(r, 10))
      return 'done'
    })
    const input = new Input.String('exec-async')
    const result = await cli.execute(input)
    expect(result).to.equal('done')
    cmd.dispose()
  })

  it('should support Input.Argv', async () => {
    const cmd = cli.command('exec-argv <val>')
    cmd.action((argv) => argv.args[0] as string)
    const input = new Input.Argv(['exec-argv', 'hello'])
    const result = await cli.execute(input)
    expect(result).to.equal('hello')
    cmd.dispose()
  })

  it('should pass spread args to action', async () => {
    const cmd = cli.command('exec-spread <a> <b>')
    let received: any[] = []
    cmd.action((argv, ...args) => {
      received = args
    })
    const input = new Input.String('exec-spread foo bar')
    await cli.execute(input)
    expect(received).to.deep.equal(['foo', 'bar'])
    cmd.dispose()
  })
})

describe('Command Dispose', () => {
  it('should remove command and aliases on dispose', () => {
    const cmd = cli.command('dispose-1')
    cmd.alias('d1', {})
    expect(cli._aliases['dispose-1']).to.exist
    expect(cli._aliases['d1']).to.exist
    cmd.dispose()
    expect(cli._aliases['dispose-1']).to.be.undefined
    expect(cli._aliases['d1']).to.be.undefined
  })
})
