import { Context, Exporter, Formatter, Logger, Message } from 'cordis'
import { Time } from 'cosmokit'
import z from 'schemastery'

export type ColorSupportLevel = 0 | 1 | 2 | 3

export interface LabelStyle {
  width?: number
  margin?: number
  align?: 'left' | 'right'
}

export namespace ConsoleExporter {
  export interface Config {
    colors?: false | ColorSupportLevel
    maxLength?: number
    levels?: Record<string, number>
    showDiff?: boolean
    showTime?: string
    label?: LabelStyle
  }
}

export class ConsoleExporter implements Exporter {
  static readonly name = 'logger-console'

  static readonly Config: z<ConsoleExporter.Config> = z.object({
    colors: z.union([z.const(false), z.number()]).description('The color support level: `false` or `0` for no colors, `1` for 16 colors, and `2` or `3` for 256 colors with text decorations.'),
    maxLength: z.number().description('The maximum length of a line, beyond which the line is truncated. Defaults to 10240.'),
    levels: z.dict(z.number()).description('The maximum levels of the messages to print, keyed by logger name. The `default` key applies to the loggers that are not listed.'),
    showDiff: z.boolean().default(false).description('Append the time elapsed since the previous message.'),
    showTime: z.string().default('yyyy-MM-dd hh:mm:ss ').description('The template of the timestamp prefixed to each message. An empty string omits the timestamp.'),
    label: z.object({
      width: z.number().description('The width to which logger names are padded.'),
      margin: z.number().description('The number of spaces that separate the type prefix, the logger name and the message. Defaults to 1.'),
      align: z.union(['left', 'right']).description('The alignment of logger names within `width`.'),
    }).description('The layout of logger names.'),
  }) as z<ConsoleExporter.Config>

  colors!: false | ColorSupportLevel
  maxLength?: number
  levels?: Record<string, number>
  showDiff!: boolean
  showTime!: string
  label?: LabelStyle
  timestamp: number

  formatters: Record<string, Formatter> = {}

  constructor(public ctx: Context, config: ConsoleExporter.Config = {}) {
    Object.assign(this, this.getDefaults(), config)
    this.timestamp = Date.now()
    ctx.logger.exporter(this)
  }

  getDefaults() {
    return {
      colors: false as false | ColorSupportLevel,
      showTime: 'yyyy-MM-dd hh:mm:ss ',
      showDiff: false,
    }
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
    output += Logger.format(this, message).replace(/\n/g, '\n' + ' '.repeat(indent))
    if (this.showDiff && this.timestamp) {
      const diff = message.ts - this.timestamp
      output += Logger.color(this, code, ' +' + Time.format(diff))
    }
    this.timestamp = message.ts
    return output
  }
}

export default ConsoleExporter
