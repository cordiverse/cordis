import { Service } from 'cordis'
import { defineProperty, isNullable } from 'cosmokit'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import accepts from 'accepts'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export class ValidationError extends Error {
  name = 'ValidationError'

  constructor(public issues: readonly StandardSchemaV1.Issue[]) {
    super('Validation failed')
  }
}

export interface Request {
  arrayBuffer(): Promise<ArrayBuffer>
  blob(): Promise<Blob>
  bytes(): Promise<Uint8Array>
  formData(): Promise<FormData>
  json(): Promise<any>
  json<S extends StandardSchemaV1>(schema: S): Promise<StandardSchemaV1.InferOutput<S>>
  text(): Promise<string>
}

export class Request {
  readonly url: string
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly headers: Headers

  private _accepts?: accepts.Accepts
  private _bodyImpl: globalThis.Response

  constructor(public _req: IncomingMessage) {
    defineProperty(this, Service.tracker, { associate: 'server.request' })
    this.url = _req.url!
    this.method = _req.method!
    this.path = this.url.split('?')[0]
    this.query = new URLSearchParams(this.url.split('?')[1])
    this.headers = new Headers()
    for (const [key, value] of Object.entries(_req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) {
          this.headers.append(key, v)
        }
      } else if (typeof value === 'string') {
        this.headers.set(key, value)
      }
    }
    this._bodyImpl = new globalThis.Response(Readable.toWeb(this._req) as ReadableStream, {
      headers: this.headers,
    })
  }

  accepts(): string[]
  accepts(types: string[]): string | false
  accepts(...types: string[]): string | false
  accepts(...args: any[]) {
    this._accepts ??= accepts(this._req)
    return this._accepts.types(...args)
  }

  get body() {
    return this._bodyImpl.body
  }

  get bodyUsed() {
    return this._bodyImpl.bodyUsed
  }

  static {
    for (const method of ['arrayBuffer', 'blob', 'bytes', 'formData', 'text'] as const) {
      this.prototype[method] = function (this: Request) {
        return this._bodyImpl[method]()
      } as any
    }
  }

  async json(schema?: StandardSchemaV1): Promise<any> {
    const data = await this._bodyImpl.json()
    if (!schema) return data
    const result = await schema['~standard'].validate(data)
    if (result.issues) throw new ValidationError(result.issues)
    return result.value
  }
}

export interface Response {
  arrayBuffer(): Promise<ArrayBuffer>
  arrayBuffer(data: BufferSource): this
  blob(): Promise<Blob>
  blob(data: Blob): this
  bytes(): Promise<Uint8Array>
  bytes(data: Uint8Array): this
  formData(): Promise<FormData>
  formData(data: FormData): this
  json(): Promise<any>
  json(data: any): this
  text(): Promise<string>
  text(data: string): this
}

export class Response {
  readonly headers = new Headers()

  private _bodyInit?: BodyInit | null
  private _claimed = false

  constructor(public _res: ServerResponse) {
    defineProperty(this, Service.tracker, { associate: 'server.response' })
  }

  get status() {
    return this._res.statusCode
  }

  set status(value) {
    this._res.statusCode = value
    this._claimed = true
  }

  get statusText() {
    return this._res.statusMessage
  }

  set statusText(value) {
    this._res.statusMessage = value
  }

  get ok() {
    return this._res.statusCode >= 200 && this._res.statusCode < 300
  }

  get redirected() {
    return this._res.statusCode >= 300 && this._res.statusCode < 400
  }

  get body() {
    if (this._bodyInit instanceof ReadableStream) {
      const [a, b] = this._bodyInit.tee()
      this._bodyInit = a
      return b
    }
    return new globalThis.Response(this._bodyInit).body
  }

  set body(value: BodyInit | null) {
    this._bodyInit = value
    this._claimed = true
  }

  get claimed() {
    return this._claimed
  }

  private _write(input: BodyInit | null) {
    const tmp = new globalThis.Response(input)
    for (const [k, v] of tmp.headers) {
      if (!this.headers.has(k)) this.headers.set(k, v)
    }
    this._bodyInit = input
    this._claimed = true
    return this
  }

  static {
    for (const method of ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'] as const) {
      this.prototype[method] = function (this: Response, ...args: any[]) {
        if (args.length === 0) {
          let source = this._bodyInit
          if (source instanceof ReadableStream) {
            const [a, b] = source.tee()
            this._bodyInit = a
            source = b
          }
          return new globalThis.Response(source)[method]()
        }
        let data = args[0]
        if (method === 'json') {
          data = JSON.stringify(data)
          if (!this.headers.has('content-type')) {
            this.headers.set('content-type', 'application/json')
          }
        }
        return this._write(data)
      } as any
    }
  }

  _end() {
    if (this._res.headersSent) return
    this._res.writeHead(this._res.statusCode, this._res.statusMessage, Object.fromEntries(this.headers))
    if (isNullable(this._bodyInit)) {
      return this._res.end()
    }
    const body = new globalThis.Response(this._bodyInit).body! as any
    Readable.fromWeb(body).pipe(this._res, { end: true })
  }
}
