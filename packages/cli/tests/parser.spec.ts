import { expect } from 'chai'
import { Input } from '../src/parser.ts'

describe('Input.String', () => {
  describe('basic tokenization', () => {
    it('should split by whitespace', () => {
      const input = new Input.String('foo bar baz')
      expect(input.next()).to.deep.include({ content: 'foo' })
      expect(input.next()).to.deep.include({ content: 'bar' })
      expect(input.next()).to.deep.include({ content: 'baz' })
      expect(input.isEmpty()).to.be.true
    })

    it('should handle leading whitespace', () => {
      const input = new Input.String('  foo')
      expect(input.next()).to.deep.include({ content: 'foo' })
      expect(input.isEmpty()).to.be.true
    })

    it('should handle empty string', () => {
      const input = new Input.String('')
      expect(input.isEmpty()).to.be.true
    })

    it('should handle single token', () => {
      const input = new Input.String('hello')
      expect(input.next()).to.deep.include({ content: 'hello' })
      expect(input.isEmpty()).to.be.true
    })
  })

  describe('quoted strings', () => {
    it('should handle double quotes', () => {
      const input = new Input.String('"foo bar" baz')
      const token = input.next()
      expect(token.content).to.equal('foo bar')
      expect(token.quotes).to.be.an('array')
      expect(input.next()).to.deep.include({ content: 'baz' })
    })

    it('should handle single quotes', () => {
      const input = new Input.String("'foo bar' baz")
      const token = input.next()
      expect(token.content).to.equal('foo bar')
      expect(token.quotes).to.be.an('array')
    })

    it('should handle left/right double quotes', () => {
      const input = new Input.String('\u201cfoo bar\u201d baz')
      const token = input.next()
      expect(token.content).to.equal('foo bar')
      expect(token.quotes).to.be.an('array')
    })

    it('should handle left/right single quotes', () => {
      const input = new Input.String('\u2018foo bar\u2019 baz')
      const token = input.next()
      expect(token.content).to.equal('foo bar')
      expect(token.quotes).to.be.an('array')
    })

    it('unquoted tokens should have no quotes property', () => {
      const input = new Input.String('foo')
      const token = input.next()
      expect(token.quotes).to.be.undefined
    })
  })

  describe('drain', () => {
    it('should return remaining input', () => {
      const input = new Input.String('foo bar baz')
      input.next() // consume 'foo'
      expect(input.drain()).to.equal('bar baz')
      expect(input.isEmpty()).to.be.true
    })

    it('should include buffered tokens in drain', () => {
      const input = new Input.String('foo bar baz')
      const token = input.next()
      input.unshift(token)
      expect(input.drain()).to.equal('foo bar baz')
    })

    it('should include quoted tokens in drain', () => {
      const input = new Input.String('"foo bar" baz')
      const token = input.next()
      input.unshift(token)
      const result = input.drain()
      expect(result).to.include('foo bar')
    })
  })

  describe('unshift', () => {
    it('should push back a token', () => {
      const input = new Input.String('foo bar')
      const token = input.next()
      expect(token.content).to.equal('foo')
      input.unshift(token)
      expect(input.next().content).to.equal('foo')
      expect(input.next().content).to.equal('bar')
    })

    it('unshifted tokens come before remaining input', () => {
      const input = new Input.String('a b c')
      input.next() // consume 'a'
      const b = input.next()
      input.unshift(b)
      expect(input.isEmpty()).to.be.false
      expect(input.next().content).to.equal('b')
    })
  })
})

describe('Input.Argv', () => {
  it('should tokenize argv array', () => {
    const input = new Input.Argv(['foo', 'bar', 'baz'])
    expect(input.next()).to.deep.include({ content: 'foo' })
    expect(input.next()).to.deep.include({ content: 'bar' })
    expect(input.next()).to.deep.include({ content: 'baz' })
    expect(input.isEmpty()).to.be.true
  })

  it('should drain remaining args', () => {
    const input = new Input.Argv(['foo', 'bar', 'baz'])
    input.next()
    expect(input.drain()).to.equal('bar baz')
  })

  it('should handle empty argv', () => {
    const input = new Input.Argv([])
    expect(input.isEmpty()).to.be.true
  })

  it('should support unshift', () => {
    const input = new Input.Argv(['a', 'b'])
    const token = input.next()
    input.unshift(token)
    expect(input.next().content).to.equal('a')
  })
})
