import { Context, Exporter, Logger, LoggerFactory, Message } from 'cordis'
import { Time } from 'cosmokit'
import { inspect } from 'node:util'
import supportsColor from 'supports-color'
import z from 'schemastery'

export type ColorSupportLevel = 0 | 1 | 2 | 3

export interface LabelStyle {
  width?: number
  margin?: number
  align?: 'left' | 'right'
}

export interface ConsoleOptions {
  colors?: false | ColorSupportLevel
  maxLength?: number
  levels?: Record<string, number>
  showDiff?: boolean
  showTime?: string
  label?: LabelStyle
  timestamp?: number
}

export class ConsoleExporter implements Exporter {
  colors!: false | ColorSupportLevel
  maxLength?: number
  levels?: Record<string, number>
  showDiff!: boolean
  showTime!: string
  label?: LabelStyle
  timestamp?: number

  constructor(options: ConsoleOptions = {}) {
    Object.assign(this, {
      colors: supportsColor.stdout ? supportsColor.stdout.level : 0,
      showTime: 'yyyy-MM-dd hh:mm:ss ',
      showDiff: false,
      ...options,
    })
  }

  export(message: Message) {
    // eslint-disable-next-line no-console
    console.log(this.render(message))
  }

  render(message: Message) {
    const prefix = `[${message.type[0].toUpperCase()}]`
    const space = ' '.repeat(this.label?.margin ?? 1)
    let indent = 3 + space.length, output = ''
    if (this.showTime) {
      indent += this.showTime.length
      output += Logger.color(this, 8, Time.template(this.showTime))
    }
    const code = Logger.code(message.name, this.colors)
    const label = Logger.color(this, code, message.name, ';1')
    const padLength = (this.label?.width ?? 0) + label.length - message.name.length
    if (this.label?.align === 'right') {
      output += label.padStart(padLength) + space + prefix + space
      indent += (this.label.width ?? 0) + space.length
    } else {
      output += prefix + space + label.padEnd(padLength) + space
    }
    output += message.body.replace(/\n/g, '\n' + ' '.repeat(indent))
    if (this.showDiff && this.timestamp) {
      const diff = message.ts - this.timestamp
      output += Logger.color(this, code, ' +' + Time.format(diff))
    }
    this.timestamp = message.ts
    return output
  }
}

export interface Config {
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

export const name = 'logger-console'

export function apply(ctx: Context, config: Config) {
  if (config.enabled === false) return

  // Install the node-only `%o` formatter so Logger calls like
  // `logger.debug('foo %o', obj)` produce inspect-style output.
  LoggerFactory.formatters.o = (value, target) => {
    return inspect(value, { colors: !!target.colors, depth: Infinity, compact: true, breakLength: Infinity })
  }

  const exporter = new ConsoleExporter({ timestamp: Date.now() })
  return ctx.logger.exporter(exporter)
}

export default { name, Config, apply }
