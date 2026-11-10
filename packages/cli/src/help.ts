import { Context } from 'cordis'
import { Cli, Command } from './index.ts'
import kleur from 'kleur'

export const name = 'cli-help'
export const inject = ['cli']

export interface Config {}

export function apply(ctx: Context, config: Config = {}) {
  const cli = ctx.cli

  cli.command('help [command:string]', 'Print help for a command')
    .option('-H, --show-hidden')
    .action(({ args, options }) => {
      const showHidden = !!(options as any).showHidden
      const target = args[0] as string | undefined
      if (!target) return showCommandList(cli, showHidden)
      const parts = args as string[]
      const resolved = resolveCommandName(cli, parts[0], parts.slice(1))
      if (!resolved) return kleur.bold().red('Error:') + ` command "${target}" not found`
      return showCommandHelp(cli, resolved.command, resolved.name, showHidden)
    })

  ctx.on('cli/execute', (input) => {
    const tokens: { content: string; quotes?: [string, string] }[] = []
    while (!input.isEmpty()) {
      tokens.push(input.next())
    }

    if (tokens.length === 0) {
      // No input: show root command help if root exists with subcommands
      const root = cli._aliases['']
      if (root) {
        const subs = getSubcommands(cli, '')
        if (subs.length > 0) {
          const hasRequiredArgs = root._arguments.some(a => a.required)
          if (!hasRequiredArgs) {
            return showCommandHelp(cli, root, '')
          }
        }
      }
      return showCommandList(cli)
    }

    const hasHelp = tokens.some(token => !token.quotes && (token.content === '-h' || token.content === '--help'))

    if (hasHelp) {
      const nonHelp = tokens.filter(t => t.content !== '-h' && t.content !== '--help')
      if (nonHelp.length) {
        const resolved = resolveCommandName(cli, nonHelp[0].content,
          nonHelp.slice(1).map(t => t.content))
        if (resolved) return showCommandHelp(cli, resolved.command, resolved.name)
      }
      // bare --help: show root help if root exists, otherwise command list
      const root = cli._aliases['']
      if (root) return showCommandHelp(cli, root, '')
      return showCommandList(cli)
    }

    // Not help — push tokens back
    for (let i = tokens.length - 1; i >= 0; i--) {
      input.unshift(tokens[i])
    }
  })

  // Handle cli/error: append usage and help hint
  ctx.on('cli/error', (command, next) => {
    let output = next('')
    const parts = command.split('.')
    const resolved = resolveCommandName(cli, parts[0], parts.slice(1))
    if (resolved) {
      const displayName = getDisplayName(cli, command)
      const optionList = Array.from(resolved.command._optionList).filter(opt => !opt.hidden)
      const hasOptions = optionList.length > 0
      const subcommands = getSubcommands(cli, resolved.name)
      const argParts = resolved.command._arguments.map(formatArg)
      const usageParts = [kleur.bold().cyan(displayName)]
      if (hasOptions) usageParts.push(kleur.cyan('[OPTIONS]'))
      if (subcommands.length) usageParts.push(kleur.cyan('[COMMAND]'))
      usageParts.push(...argParts)
      output += '\n\n' + kleur.bold().green('Usage:') + ' ' + usageParts.join(' ')
    }
    output += '\n\n' + 'For more information, try ' + kleur.bold().cyan("'--help'") + '.'
    return output
  })
}

function resolveCommandName(cli: Cli, first: string, rest: string[]): { command: Command; name: string } | null {
  let command = cli._aliases[first]
  if (!command) return null
  let name = first
  for (const part of rest) {
    const sub = cli._aliases[`${name}.${part}`]
    if (!sub) break
    command = sub
    name = `${name}.${part}`
  }
  return { command, name }
}

function getSubcommands(cli: Cli, parentName: string, showHidden = false): { command: Command; name: string }[] {
  const subs: { command: Command; name: string }[] = []
  const seen = new Set<Command>()
  if (parentName === '') {
    // Root command: direct children are all top-level commands (no dots in name)
    for (const cmd of cli._commands) {
      if (seen.has(cmd)) continue
      const name = Object.keys(cmd._aliases)[0]
      if (name === undefined || name === '') continue // skip root itself
      if (name.includes('.')) continue // skip nested
      if (!showHidden && cmd.config.hidden) continue
      seen.add(cmd)
      subs.push({ command: cmd, name })
    }
  } else {
    const prefix = parentName + '.'
    for (const cmd of cli._commands) {
      if (seen.has(cmd)) continue
      const name = Object.keys(cmd._aliases)[0]
      if (!name?.startsWith(prefix)) continue
      const rest = name.slice(prefix.length)
      if (rest.includes('.')) continue
      if (!showHidden && cmd.config.hidden) continue
      seen.add(cmd)
      subs.push({ command: cmd, name })
    }
  }
  return subs.sort((a, b) => a.name.localeCompare(b.name))
}

function showCommandList(cli: Cli, showHidden = false): string {
  const commands = Array.from(cli._commands)
    .filter((cmd) => {
      const name = Object.keys(cmd._aliases)[0] || ''
      if (name.includes('.')) return false // only top-level
      if (!showHidden && cmd.config.hidden) return false
      return Object.keys(cmd._aliases).length > 0
    })
    .sort((a, b) => {
      const nameA = Object.keys(a._aliases)[0] || ''
      const nameB = Object.keys(b._aliases)[0] || ''
      return nameA.localeCompare(nameB)
    })

  const prefix = cli.config.name ? cli.config.name + ' ' : ''
  const lines: string[] = [kleur.bold().green('Usage:') + ` ${prefix}<COMMAND> [OPTIONS]`, '']

  if (commands.length === 0) {
    lines.push('No commands available.')
    return lines.join('\n')
  }

  lines.push(kleur.bold().green('Commands:'))
  const entries = commands.map(cmd => {
    const name = Object.keys(cmd._aliases)[0] || ''
    return { name, desc: cmd.description }
  })
  const maxLen = Math.max(...entries.map(e => e.name.length))

  for (const entry of entries) {
    const pad = ' '.repeat(Math.max(2, maxLen - entry.name.length + 4))
    const desc = entry.desc ? pad + entry.desc : ''
    lines.push('  ' + kleur.bold().cyan(entry.name) + desc)
  }

  lines.push('', 'See ' + kleur.bold().cyan("'<command> --help'") + ' for more information on a specific command.')
  return lines.join('\n')
}

function getDisplayName(cli: Cli, name: string): string {
  const prefix = cli.config.name || ''
  const commandName = name.replace(/\./g, ' ')
  return [prefix, commandName].filter(Boolean).join(' ')
}

function showCommandHelp(cli: Cli, command: Command, name: string, showHidden = false): string {
  const displayName = getDisplayName(cli, name)
  const argParts = command._arguments.map(formatArg)
  const optionList = Array.from(command._optionList)
    .filter(opt => showHidden || !opt.hidden)
  const hasOptions = optionList.length > 0
  const subcommands = getSubcommands(cli, name, showHidden)

  // Description
  const lines: string[] = []
  if (command.description) {
    lines.push(command.description, '')
  }

  // Usage
  const usageParts: string[] = []
  if (displayName) usageParts.push(kleur.bold().cyan(displayName))
  if (hasOptions) usageParts.push(kleur.cyan('[OPTIONS]'))
  if (subcommands.length) usageParts.push(kleur.cyan('[COMMAND]'))
  usageParts.push(...argParts)
  lines.push(kleur.bold().green('Usage:') + ' ' + usageParts.join(' '))

  // Arguments
  if (command._arguments.length > 0) {
    lines.push('', kleur.bold().green('Arguments:'))
    for (const arg of command._arguments) {
      lines.push('  ' + kleur.bold().cyan(formatArg(arg)))
    }
  }

  // Options
  if (hasOptions) {
    lines.push('', kleur.bold().green('Options:'))
    const maxLen = Math.max(...optionList.map(o => o.source.length))
    for (const option of optionList) {
      const pad = ' '.repeat(Math.max(2, maxLen - option.source.length + 4))
      const desc = option.description ? pad + option.description : ''
      lines.push('  ' + kleur.bold().cyan(option.source) + desc)
    }
  }

  // Subcommands
  if (subcommands.length) {
    lines.push('', kleur.bold().green('Commands:'))
    const stripLen = name ? name.length + 1 : 0
    const maxLen = Math.max(...subcommands.map(s => s.name.slice(stripLen).length))
    for (const sub of subcommands) {
      const subName = sub.name.slice(stripLen)
      const pad = ' '.repeat(Math.max(2, maxLen - subName.length + 4))
      const desc = sub.command.description ? pad + sub.command.description : ''
      lines.push('  ' + kleur.bold().cyan(subName) + desc)
    }
  }

  // Aliases
  const aliases = Object.keys(command._aliases).slice(1)
  if (aliases.length > 0) {
    lines.push('', kleur.bold().green('Aliases:') + ' ' + aliases.join(', '))
  }

  return lines.join('\n')
}

function formatArg(arg: { name: string; required: boolean; variadic: boolean }): string {
  const prefix = arg.variadic ? '...' : ''
  return arg.required ? `<${prefix}${arg.name}>` : `[${prefix}${arg.name}]`
}
