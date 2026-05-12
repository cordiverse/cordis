import { Message } from 'cordis'
import { ConsoleExporter as Base } from './shared.js'

export * from './shared.js'

export class ConsoleExporter extends Base {
  static readonly name = 'logger-console'

  export(message: Message) {
    const prefix = `[${message.type[0].toUpperCase()}] ${message.name}`
    const method = message.type === 'error' ? 'error' : message.type === 'warn' ? 'warn' : 'log'
    // eslint-disable-next-line no-console
    console[method](prefix, ...message.args)
  }
}

export default ConsoleExporter
