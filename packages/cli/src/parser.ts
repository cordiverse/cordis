export interface Token {
  content: string
  quotes?: [string, string]
}

export interface Input {
  isEmpty(): boolean
  drain(): string
  next(): Token
  unshift(token: Token): void
}

export namespace Input {
  const LEFT_QUOTES = `"'“‘`
  const RIGHT_QUOTES = `"'”’`

  export class String implements Input {
    private buffer: Token[] = []
    private input: string

    constructor(input: string) {
      this.input = input.trimStart()
    }

    isEmpty(): boolean {
      return this.input.length === 0 && this.buffer.length === 0
    }

    drain(): string {
      const content = this.buffer.map(({ content, quotes }) => {
        return quotes ? `${quotes[0]}${content}${quotes[1]} ` : content + ' '
      }).join('') + this.input
      this.input = ''
      this.buffer = []
      return content
    }

    next(): Token {
      if (this.buffer.length > 0) {
        return this.buffer.pop()!
      }
      const quoteIndex = LEFT_QUOTES.indexOf(this.input[0])
      const rightQuote = RIGHT_QUOTES[quoteIndex]
      const stopReg = new RegExp(rightQuote ? `${rightQuote}([\\s]+|$)|$` : `[\\s]+|$`)
      const capture = stopReg.exec(this.input)!
      const content = this.input.slice(rightQuote ? 1 : 0, capture.index)
      this.input = this.input.slice(capture.index + capture[0].length)
      return {
        content,
        quotes: rightQuote
          ? [LEFT_QUOTES[quoteIndex], capture[0] === rightQuote ? rightQuote : '']
          : undefined,
      }
    }

    unshift(token: Token) {
      this.buffer.push(token)
    }
  }

  export class Argv implements Input {
    private buffer: Token[] = []

    constructor(private input: string[] = process.argv.slice(2)) {}

    isEmpty(): boolean {
      return this.input.length === 0 && this.buffer.length === 0
    }

    drain(): string {
      const input = this.input
      this.input = []
      return input.join(' ')
    }

    next(): Token {
      if (this.buffer.length > 0) {
        return this.buffer.pop()!
      }
      return {
        content: this.input.shift()!,
      }
    }

    unshift(token: Token) {
      this.buffer.push(token)
    }
  }
}
