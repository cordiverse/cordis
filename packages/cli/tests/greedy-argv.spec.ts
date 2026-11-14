import { beforeAll, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { Cli, Input } from '@cordisjs/cli'

describe('greedy argv arguments', () => {
  const ctx = new Context()

  beforeAll(async () => {
    await ctx.use(Cli)
  })

  it.each([
    [['echo', 'hello'], 'hello'],
    [['echo', 'hello', 'world'], 'hello world'],
  ])('preserves the first argument after command resolution: %j', async (args, expected) => {
    const command = ctx.cli.command('echo <message:text>')
    command.action((_argv, message) => message)
    try {
      expect(await ctx.cli.execute(new Input.Argv(args))).to.equal(expected)
    } finally {
      command.dispose()
    }
  })

  it('drains pushed-back tokens in the same order as next()', () => {
    const input = new Input.Argv(['third'])
    input.unshift({ content: 'second' })
    input.unshift({ content: 'first' })

    expect(input.drain()).to.equal('first second third')
    expect(input.isEmpty()).to.be.true
    expect(input.drain()).to.equal('')
  })

  it('drains a pushed-back token when the argv array is exhausted', () => {
    const input = new Input.Argv(['only'])
    input.unshift(input.next())

    expect(input.drain()).to.equal('only')
    expect(input.isEmpty()).to.be.true
  })
})
