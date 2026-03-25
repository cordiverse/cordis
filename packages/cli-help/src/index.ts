import { Context as help } from 'cordis'
import type CLI from '@cordisjs/plugin-cli'
import type { Command } from '@cordisjs/plugin-cli'

export const name = 'cli-help'
export const inject = ['cli']

export interface Config {
  /** Intercept -h/--help on all commands */
  options?: boolean
}

export function apply(ctx: help, config: Config = {}) {
  const { options = true } = config
  const cli = ctx.cli

  // Register help command
  cli.command('help [command:string]', 'show help information')
    .option('-H, --show-hidden', 'show hidden commands')
    .action((argv) => {
      const target = argv.args[0] as string | undefined
      if (!target) {
        return showCommandList(cli)
      }
      const command = cli._aliases[target]
      if (!command) {
        return `command "${target}" not found`
      }
      return showCommandHelp(command)
    })

  if (options) {
    // Wrap cli.execute to intercept -h/--help before normal parsing
    const origExecute = cli.execute.bind(cli)
    cli.execute = function (input, args, opts) {
      // Peek at the tokens to check for -h/--help
      // Collect all tokens first
      const tokens: { content: string; quotes?: [string, string] }[] = []
      while (!input.isEmpty()) {
        tokens.push(input.next())
      }

      if (tokens.length === 0) {
        throw new Error('no command provided')
      }

      // Check if any token is -h or --help (unquoted)
      const hasHelp = tokens.some((t, i) =>
        i > 0 && !t.quotes && (t.content === '-h' || t.content === '--help'),
      )

      if (hasHelp) {
        // First token is the command name
        const cmdName = tokens[0].content
        const command = cli._aliases[cmdName]
        if (command) {
          return Promise.resolve(showCommandHelp(command))
        }
      }

      // Reconstruct the input and call original execute
      // Push tokens back in reverse order
      for (let i = tokens.length - 1; i >= 0; i--) {
        input.unshift(tokens[i])
      }
      return origExecute(input, args, opts)
    }
  }
}

function showCommandList(cli: CLI): string {
  const lines: string[] = ['Available commands:', '']

  const commands = Array.from(cli._commands)
    .filter((cmd) => Object.keys(cmd._aliases).length > 0)
    .sort((a, b) => {
      const nameA = Object.keys(a._aliases)[0] || ''
      const nameB = Object.keys(b._aliases)[0] || ''
      return nameA.localeCompare(nameB)
    })

  if (commands.length === 0) {
    lines.push('  (no commands registered)')
  } else {
    const nameCol = commands.map((cmd) => {
      const name = Object.keys(cmd._aliases)[0] || ''
      return formatCommandSignature(cmd, name)
    })
    const maxLen = Math.max(...nameCol.map(n => n.length))

    for (let i = 0; i < commands.length; i++) {
      const sig = nameCol[i]
      const pad = ' '.repeat(Math.max(2, maxLen - sig.length + 2))
      lines.push(`  ${sig}${pad}`)
    }
  }

  lines.push('')
  lines.push('Use "help <command>" for more information about a command.')
  return lines.join('\n')
}

function formatCommandSignature(command: Command, name: string): string {
  const argParts = command._arguments.map((arg) => {
    const variadicPrefix = arg.variadic ? '...' : ''
    if (arg.required) {
      return `<${variadicPrefix}${arg.name}>`
    }
    return `[${variadicPrefix}${arg.name}]`
  })
  return argParts.length > 0 ? `${name} ${argParts.join(' ')}` : name
}

function showCommandHelp(command: Command): string {
  const name = Object.keys(command._aliases)[0] || 'unknown'
  const lines: string[] = []

  // Title with signature
  const signature = formatCommandSignature(command, name)
  lines.push(`Usage: ${signature}`)

  // Aliases
  const aliases = Object.keys(command._aliases).slice(1)
  if (aliases.length > 0) {
    lines.push(`Aliases: ${aliases.join(', ')}`)
  }

  // Options
  const optionList = Array.from(command._optionList)
  if (optionList.length > 0) {
    lines.push('')
    lines.push('Options:')

    for (const option of optionList) {
      lines.push(`  ${option.source}`)
    }
  }

  return lines.join('\n')
}
