import { Context, DisposableList, Service } from 'cordis'
import { Dict, hyphenate, Time } from 'cosmokit'
import type {} from '@cordisjs/loader'
import { CliSyntaxError, Command, CommandConfig, ParseArgument } from './command.ts'
import { Input } from './parser.ts'
import * as help from './help.ts'
import kleur from 'kleur'

export * from './command.ts'
export * from './parser.ts'

declare module 'cordis' {
  interface Context {
    cli: Cli
  }

  interface Events {
    'cli/execute'(input: Input): any
    'cli/error'(command: string, next: (output: string) => string): string
  }
}

// https://github.com/microsoft/TypeScript/issues/17002
// it never got fixed so we have to do this
const isArray = Array.isArray as (arg: any) => arg is readonly any[]

const BRACKET_REGEXP = /<([^<>]+)>|\[([^\[\]]+)\]/g

export interface Type<T = any> {
  name?: string
  parse: Type.Parse<T>
  greedy?: boolean
  numeric?: boolean
}

export namespace Type {
  export type Parse<T = any> = (source: string) => T
}

export interface Types {
  string: string
  text: string
  boolean: boolean
  number: number
  integer: number
  posint: number
  natural: number
  date: Date
  time: Date
  datetime: Date
}

export type TypeInit =
  | RegExp
  | keyof Types
  | readonly string[]
  | Type.Parse
  | Type
  | undefined

export type ResolveTypeInit<T extends TypeInit> =
  | T extends RegExp ? string
  : T extends readonly (infer T)[] ? T
  : T extends Type.Parse<infer T> ? T
  : T extends Type<infer T> ? T
  : T extends undefined ? string // default type
  : never

export type ParamKind = 'argument' | 'option'

export interface Param extends Type {
  kind: ParamKind
  name: string
  variadic: boolean
  required: boolean
}

export namespace Cli {
  export interface Config {
    name?: string
  }
}

export class Cli extends Service {
  _builtin: Dict<Type | undefined> = {}
  _commands = new DisposableList<Command>()
  _aliases: Dict<Command | undefined> = Object.create(null)

  constructor(ctx: Context, public config: Cli.Config = {}) {
    super(ctx, 'cli')

    this.define('string', source => source)
    this.define('text', source => source, { greedy: true })
    this.define('boolean', () => true)

    this.define('number', (source) => {
      const value = +source
      if (Number.isFinite(value)) return value
      throw new Error('internal.invalid-number')
    }, { numeric: true })

    this.define('integer', (source) => {
      const value = +source
      if (value * 0 === 0 && Math.floor(value) === value) return value
      throw new Error('internal.invalid-integer')
    }, { numeric: true })

    this.define('posint', (source) => {
      const value = +source
      if (value * 0 === 0 && Math.floor(value) === value && value > 0) return value
      throw new Error('internal.invalid-posint')
    }, { numeric: true })

    this.define('natural', (source) => {
      const value = +source
      if (value * 0 === 0 && Math.floor(value) === value && value >= 0) return value
      throw new Error('internal.invalid-natural')
    }, { numeric: true })

    this.define('date', (source) => {
      const timestamp = Time.parseDate(source)
      if (+timestamp) return timestamp
      throw new Error('internal.invalid-date')
    })

    help.apply(ctx)

    if (ctx.fiber.entry) {
      ctx.inject({
        loader: { await: true },
      }, () => this.executeArgv())
    }
  }

  define<K extends keyof Types>(name: K, parse: Type.Parse<Types[K]>, options?: Omit<Type<Types[K]>, 'parse'>) {
    return this.ctx.effect(() => {
      this._builtin[name] = { name, ...options, parse }
      return () => delete this._builtin[name]
    })
  }

  parseType(type: any): Type {
    if (typeof type === 'string') {
      type = this._builtin[type]
      if (!type) throw new Error(`unknown type "${type}"`)
      return type
    } else if (typeof type === 'function') {
      return { parse: type }
    } else if (type instanceof RegExp) {
      const parse = (source: string) => {
        if (type.test(source)) return source
        throw new Error()
      }
      return { parse }
    } else if (isArray(type)) {
      const parse = (source: string) => {
        if (type.includes(source)) return source
        throw new Error()
      }
      return { parse }
    }
    return type ?? { parse: source => source }
  }

  parseParams(source: string, kind: ParamKind): Param[] {
    let cap: RegExpExecArray | null
    const args: Param[] = []
    while ((cap = BRACKET_REGEXP.exec(source))) {
      let rawName = cap[1] || cap[2]
      let variadic = false
      if (rawName.startsWith('...')) {
        rawName = rawName.slice(3)
        variadic = true
      }
      const [name, rawType] = rawName.split(':')
      args.push({
        ...this.parseType(rawType),
        name,
        kind,
        variadic,
        required: cap[0][0] === '<',
      })
    }
    return args
  }

  command<S extends string>(source: S, config?: CommandConfig): Command<ParseArgument<S>>
  command<S extends string>(source: S, desc: string, config?: CommandConfig): Command<ParseArgument<S>>
  command(source: string, ...args: [CommandConfig?] | [string, CommandConfig?]) {
    const desc = typeof args[0] === 'string' ? args.shift() as string : ''
    const config = (args[0] || {}) as CommandConfig
    const [path] = source.split(/(?=[\s<\[])/, 1)
    source = source.slice(path.length).trimStart()
    const command = new Command(this.ctx, hyphenate(path), source, desc, config)
    command._arguments = this.parseParams(source, 'argument')
    return command
  }

  async execute(input: Input, args: any[] = [], options: Dict = {}): Promise<string | undefined> {
    // bail: components (like help) can intercept by returning a result
    const intercepted = this.ctx.bail('cli/execute', input)
    if (intercepted !== undefined) return intercepted

    // Start from root command if it exists, otherwise require a command token
    let resolved = this._aliases['']
    let name = ''

    // Try to resolve command from input tokens
    while (!input.isEmpty()) {
      const token = input.next()
      const subName = name ? `${name}.${token.content}` : token.content
      const sub = this._aliases[subName]
      if (sub) {
        resolved = sub
        name = subName
      } else {
        input.unshift(token)
        break
      }
    }

    if (!resolved) {
      if (input.isEmpty()) throw new CliSyntaxError('no command provided')
      throw new CliSyntaxError(`command "${input.next().content}" not found`)
    }

    try {
      const argv = resolved.parse(input, args, options)
      return await resolved.execute(argv) as string | undefined
    } catch (error: any) {
      if (error instanceof CliSyntaxError) {
        // If "too many arguments" and command has subcommands,
        // it's likely a typo'd subcommand name
        if (error.message === 'too many arguments') {
          const prefix = name ? name + '.' : ''
          for (const cmd of this._commands) {
            const cmdName = Object.keys(cmd._aliases)[0]
            if (cmdName !== undefined && cmdName.startsWith(prefix) && cmdName !== name) {
              error.message = `unknown command`
              break
            }
          }
        }
        error.command ||= name
      }
      throw error
    }
  }

  async executeArgv() {
    /* eslint-disable no-console */
    const input = new Input.Argv()
    try {
      const output = await this.execute(input)
      if (output) console.log(output)
    } catch (error: any) {
      if (error instanceof CliSyntaxError) {
        const output = this.ctx.waterfall('cli/error', error.command, () => {
          return kleur.bold().red('Error:') + ' ' + error.message
        })
        console.error(output)
      } else {
        console.error(error)
      }
      process.exit(1)
    }
    /* eslint-enable no-console */
  }
}

export default Cli
