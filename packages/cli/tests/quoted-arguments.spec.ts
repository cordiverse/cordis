import { beforeAll, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { Cli, Input } from '@cordisjs/cli'

describe('quoted positional arguments', () => {
  const ctx = new Context()

  beforeAll(async () => {
    await ctx.use(Cli)
  })

  it.each(['"--verbose"', "'--verbose'", '“--verbose”', '‘--verbose’'])('preserves %s as text', (source) => {
    const command = ctx.cli.command('echo <value>')
      .option('--verbose')
    try {
      const result = command.parse(new Input.String(source))
      expect(result.args).to.deep.equal(['--verbose'])
      expect(result.options.verbose).to.be.undefined
    } finally {
      command.dispose()
    }
  })

  it('recognizes the next unquoted option after a quoted argument', async () => {
    const command = ctx.cli.command('echo <value>')
      .option('--verbose')
    command.action((argv, value) => `${value}:${argv.options.verbose}`)
    try {
      expect(await ctx.cli.execute(new Input.String('echo "--literal" --verbose')))
        .to.equal('--literal:true')
    } finally {
      command.dispose()
    }
  })

  it('accepts a quoted negative-looking value for an unknown option', () => {
    const command = ctx.cli.command('echo', { unknownOption: 'allow' })
    try {
      const result = command.parse(new Input.String('--value "--literal"'))
      expect(result.options.value).to.equal('--literal')
    } finally {
      command.dispose()
    }
  })
})
