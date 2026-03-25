import { Context } from 'cordis'
import { expect } from 'chai'
import CLI from '../../cli/src/index.ts'
import * as help from '../src/index.ts'
import { Input } from '../../cli/src/parser.ts'

let ctx: Context
let cli: CLI

before(async () => {
  ctx = new Context()
  ctx.plugin(CLI)
  await new Promise(r => setTimeout(r, 100))
  cli = ctx.cli
  ctx.plugin(help)
  await new Promise(r => setTimeout(r, 100))
})

describe('plugin-cli-help', () => {
  describe('help command', () => {
    it('should register help command', () => {
      expect(cli._aliases['help']).to.exist
    })

    it('should list available commands', async () => {
      const cmd = cli.command('greet <name>')
      const input = new Input.String('help')
      const result = await cli.execute(input)
      expect(result).to.be.a('string')
      expect(result).to.include('greet')
      expect(result).to.include('help')
      cmd.dispose()
    })

    it('should show help for specific command', async () => {
      const cmd = cli.command('deploy <target>')
      cmd.option('-f, --force')
      cmd.option('-p, --port <port:number>')
      const input = new Input.String('help deploy')
      const result = await cli.execute(input)
      expect(result).to.be.a('string')
      expect(result).to.include('deploy')
      expect(result).to.include('<target>')
      expect(result).to.include('-f, --force')
      expect(result).to.include('-p, --port <port:number>')
      cmd.dispose()
    })

    it('should report unknown command', async () => {
      const input = new Input.String('help nonexistent')
      const result = await cli.execute(input)
      expect(result).to.include('not found')
    })

    it('should show aliases', async () => {
      const cmd = cli.command('install')
      cmd.alias('i', {})
      const input = new Input.String('help install')
      const result = await cli.execute(input)
      expect(result).to.include('Aliases')
      expect(result).to.include('i')
      cmd.dispose()
    })

    it('should show usage hint in list', async () => {
      const input = new Input.String('help')
      const result = await cli.execute(input)
      expect(result).to.include('help <command>')
    })
  })

  describe('-h / --help interception', () => {
    it('should intercept -h and show help', async () => {
      const cmd = cli.command('my-cmd <file>')
      cmd.option('-v, --verbose')
      let actionCalled = false
      cmd.action(() => { actionCalled = true; return 'action result' })

      const input = new Input.String('my-cmd -h')
      const result = await cli.execute(input)
      expect(actionCalled).to.be.false
      expect(result).to.be.a('string')
      expect(result).to.include('my-cmd')
      expect(result).to.include('<file>')
      cmd.dispose()
    })

    it('should intercept --help and show help', async () => {
      const cmd = cli.command('another-cmd')
      cmd.action(() => 'normal')

      const input = new Input.String('another-cmd --help')
      const result = await cli.execute(input)
      expect(result).to.be.a('string')
      expect(result).to.include('another-cmd')
      cmd.dispose()
    })

    it('should not intercept when -h not passed', async () => {
      const cmd = cli.command('normal-cmd')
      cmd.action(() => 'normal result')

      const input = new Input.String('normal-cmd')
      const result = await cli.execute(input)
      expect(result).to.equal('normal result')
      cmd.dispose()
    })

    it('should intercept even with missing required args', async () => {
      const cmd = cli.command('strict-cmd <a> <b> <c>')
      cmd.action(() => 'should not run')

      // Only pass -h, no required args — should still show help
      const input = new Input.String('strict-cmd --help')
      const result = await cli.execute(input)
      expect(result).to.include('strict-cmd')
      expect(result).to.include('<a>')
      cmd.dispose()
    })

    it('should show options in help output', async () => {
      const cmd = cli.command('opts-cmd')
      cmd.option('-v, --verbose')
      cmd.option('-o, --output <path>')

      const input = new Input.String('opts-cmd -h')
      const result = await cli.execute(input)
      expect(result).to.include('-v, --verbose')
      expect(result).to.include('-o, --output <path>')
      cmd.dispose()
    })
  })
})
