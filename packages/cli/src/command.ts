import { Context, DisposableList, Service } from 'cordis'
import { camelize, defineProperty, Dict } from 'cosmokit'
import { Param, ResolveTypeInit, TypeInit, Types } from '.'
import { Input } from './parser.ts'

export interface CommandConfig {
  unknownNegative?: 'option' | 'string'
  unknownOption?: 'allow' | 'error'
}

export interface CommandAlias {
  options?: {}
  args?: any[]
}

export type CommandAction<A extends any[] = any[], O extends {} = {}> =
  | ((argv: Argv<A, O>, ...args: A) => string | void | Promise<string | void>)

export interface OptionConfig<T extends TypeInit = TypeInit> {
  type?: T
  default?: any
  descPath?: string
}

export interface TypedOptionConfig<T extends TypeInit> extends OptionConfig<T> {
  type: T
}

export interface Option extends Omit<OptionConfig, 'type'> {
  source: string
  names: string[]
  param?: Param
}

export interface Argv<A extends any[] = any[], O extends {} = {}> {
  args: A
  options: O
  command: Command<A, O>
}

export type TakeUntil<S extends string, D extends string, O extends string = ''> =
  | S extends `${infer C}${infer S}`
  ? C extends D ? [O, S, C] : TakeUntil<S, D, `${O}${C}`>
  : [O, S]

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type ParseParamType<S extends string, D extends string, T> =
  | TakeUntil<S, ':' | D> extends [string, infer S extends string, infer C]
  ? | C extends ':'
    ? | TakeUntil<S, D> extends [infer K extends keyof Types, infer S extends string, D]
      ? [Types[K], S]
      : [] // use [] instead of never
    : C extends D
    ? [T, S]
    : []
  : []

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type ParseOptionType<S extends string, D extends string, T> =
  | ParseParamType<S, D, T> extends [infer T, string]
  ? S extends `..${string}` ? T[] : T
  : never

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type ParseOption<S extends string, T, K extends string = never> =
  | S extends `${infer C}${infer S}`
  ? | C extends ' ' | ',' | '-'
    ? ParseOption<S, T, K>
    : C extends '<'
    ? { [P in K]: ParseOptionType<S, '>', T> }
    : C extends '['
    ? { [P in K]?: ParseOptionType<S, ']', T> }
    : TakeUntil<S, ' ' | ',', C> extends [infer P extends string, infer R extends string, any?]
    ? ParseOption<R, T, K | camelize<P>>
    : never
  : { [P in K]?: boolean }

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type ParseArgument<S extends string, A extends any[] = []> =
  | S extends `${infer C}${infer S}`
  ? | C extends '<'
    ? | ParseParamType<S, '>', string> extends [infer T, infer R extends string]
      ? | S extends `..${string}`
        ? [...A, ...T[]]
        : ParseArgument<R, [...A, T]>
      : never
    : C extends '['
    ? | ParseParamType<S, ']', string> extends [infer T, infer R extends string]
      ? | S extends `..${string}`
        ? [...A, ...T[]]
        : ParseArgument<R, [...A, T?]>
      : never
    : ParseArgument<S, A>
  : A

export class Command<A extends any[] = any[], O extends {} = {}> {
  _arguments: Param[] = []
  _optionList = new DisposableList<Option>()
  _optionDict: Dict<Option | undefined> = Object.create(null)
  _aliases: Dict<CommandAlias> = Object.create(null)
  _action?: CommandAction

  parent?: Command
  dispose: () => void

  constructor(public ctx: Context, name: string, source: string, desc: string, public config: CommandConfig) {
    defineProperty(this, Service.tracker, {
      property: 'ctx',
    })
    const self = this
    this.dispose = ctx.effect(function* () {
      yield ctx.cli._commands.push(self)
      self._aliases[name] = {}
      ctx.cli._aliases[name] = self
      yield () => {
        for (const name in self._aliases) {
          delete ctx.cli._aliases[name]
        }
      }
    })
  }

  * [Service.init]() {
    yield this.ctx.cli._commands.push(this)
  }

  alias(name: string, alias: CommandAlias) {
    const self = this
    return this.ctx.effect(function* () {
      self._aliases[name] = alias
      yield () => delete self._aliases[name]
      if (name.startsWith('.')) return
      self.ctx.cli._aliases[name] = self
      yield () => delete self.ctx.cli._aliases[name]
    })
  }

  option<S extends string, const T extends TypeInit = undefined>(
    def: S,
    config?: OptionConfig<T>,
  ): Command<A, O & ParseOption<S, ResolveTypeInit<T>>>

  option<S extends string, const T extends TypeInit = undefined>(
    def: S,
    desc: string,
    config?: OptionConfig<T>,
  ): Command<A, O & ParseOption<S, ResolveTypeInit<T>>>

  option(source: string, ...args: [OptionConfig?] | [string, OptionConfig?]) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const desc = typeof args[0] === 'string' ? args.shift() as string : ''
    const { type, ...rest } = (args[0] || {}) as OptionConfig
    let def = source.trimStart()
    let cap: RegExpExecArray | null
    const names: string[] = []
    while ((cap = /^(-+)([^\s,<\[]+)[,\s]*/.exec(def))) {
      if (cap[2].length > 1 && cap[1] === '-') {
        throw new TypeError('invalid option name')
      }
      def = def.slice(cap.index + cap[0].length)
      names.push(camelize(cap[2]))
    }
    const params = this.ctx.cli.parseParams(def, 'option')
    if (params.length > 1) {
      throw new TypeError('option accepts at most one argument')
    }
    const param = params[0]
    if (type) {
      if (!param) {
        throw new TypeError('option with type requires argument')
      }
      Object.assign(param, this.ctx.cli.parseType(type))
    }
    const option: Option = {
      ...rest,
      names,
      source,
      param,
    }
    const conflicts = names.filter(name => this._optionDict[name])
    if (conflicts.length) {
      throw new TypeError(`duplicate option: ${conflicts.join(', ')}`)
    }
    const self = this
    this.ctx.effect(function* () {
      yield self._optionList.push(option)
      for (const name of names) {
        self._optionDict[name] = option
      }
      yield () => {
        for (const name of names) {
          delete self._optionDict[name]
        }
      }
    })
    return this
  }

  parse(input: Input, args: any[] = [], options: Dict = {}): Argv {
    let variadic: Param | undefined
    let option: Option | undefined
    let names: string | string[]
    let quotes: [string, string] | undefined
    const _options: Dict = Object.create(null)

    const isParam = (content: string) => {
      return content[0] !== '-'
        || quotes
        || (+content) * 0 === 0 && this.config.unknownNegative !== 'option' && !this._optionDict[content.slice(1)]
    }

    while (!input.isEmpty()) {
      // variadic argument
      const param = this._arguments[args.length] || variadic
      if (param.variadic) variadic = param
      if (!param) throw new TypeError('too many arguments')

      // greedy argument
      if (param.greedy) {
        args.push(param.parse(input.drain()))
        break
      }

      // normal argument
      // 1. tokens not starting with `-`
      // 2. quoted tokens
      // 3. numeric tokens at numeric type
      let { content, quotes } = input.next()
      if (isParam(content)) {
        args.push(param.parse(content))
        continue
      }

      // find -
      let i = 0
      for (; i < content.length; ++i) {
        if (content.charCodeAt(i) !== 45) break
      }

      // find =
      let j = i + 1
      for (; j < content.length; j++) {
        if (content.charCodeAt(j) === 61) break
      }

      const name = content.slice(i, j)
      names = i > 1 ? [camelize(name)] : name
      content = content.slice(++j)

      // peak parameter from next token
      quotes = undefined
      if (!content) {
        option = this._optionDict[names[names.length - 1]]
        if (option) {
          if (option.param?.greedy) {
            content = input.drain()
          } else if (option.param) {
            const token = input.next()
            content = token.content
            quotes = token.quotes
          }
        } else if (
          i > 1
          && content.slice(i, j).startsWith('no-')
          && (option = this._optionDict[camelize(content.slice(i + 3, j))])
        ) {
          // explicit set undefined to skip default
          _options[option.source] = undefined
        } else if (!input.isEmpty() && this.config.unknownOption === 'allow') {
          const token = input.next()
          if (isParam(token.content)) {
            content = token.content
            quotes = token.quotes
          } else {
            input.unshift(token)
          }
        }
      }

      // handle each name
      for (let j = 0; j < names.length; j++) {
        const name = names[j]
        const option = this._optionDict[name]
        const _content = j === names.length - 1 ? content : ''
        if (option) {
          const value = option.param ? option.param.parse(_content) : true
          if (option.param?.variadic) {
            (_options[option.source] ??= []).push(value)
          } else {
            _options[option.source] = value
          }
        } else if (this.config.unknownOption === 'allow') {
          options[name] = j === names.length - 1 || quotes ? _content : true
        } else {
          throw new TypeError(`unknown option: "${name}"`)
        }
      }
    }

    // check argument count
    if (args.length < this._arguments.length) {
      const extra = this._arguments.slice(args.length)
      throw new TypeError(`missing arguments: ${extra.map(arg => `"${arg.name}"`).join(', ')}`)
    }

    // assign option values with default
    const missing: string[] = []
    for (const option of this._optionList) {
      let value = _options[option.source]
      if (value === undefined && !(option.source in _options)) {
        value = option.default
      }
      if (value === undefined) {
        if (option.param?.required) missing.push(option.source)
        continue
      }
      for (const name of option.names) {
        options[name] = value
      }
    }
    if (missing.length) {
      throw new TypeError(`missing options: ${missing.map(source => `"${source}"`).join(', ')}`)
    }

    return { args, options, command: this }
  }

  action(action: CommandAction<A, O>) {
    this._action = action as any
  }

  async execute(argv: Argv<A, O>) {
    return this._action?.(argv, ...argv.args)
  }
}
