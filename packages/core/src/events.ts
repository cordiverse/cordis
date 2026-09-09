import { Awaitable, defineProperty, Promisify } from 'cosmokit'
import { Context } from './context'
import { Fiber, FiberState } from './fiber'
import { DisposableList, symbols } from './utils'

export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export type Parameters<F> = F extends (...args: infer P) => any ? P : never
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never

export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'

declare module './context' {
  export interface Context {
    /* eslint-disable max-len */
    parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>
    parallel<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promise<void>
    emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void
    emit<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): void
    serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    serial<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>
    bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    bail<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    waterfall<K extends keyof Events>(thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    waterfallWith<K extends keyof Events>(options: WaterfallOptions, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    waterfallWith<K extends keyof Events>(options: WaterfallOptions, thisArg: NoInfer<ThisType<Events[K]>>, name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>
    on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
    once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
    /* eslint-enable max-len */
  }
}

/**
 * Options for {@link Context.waterfallWith}.
 *
 * - `signal`: an optional `AbortSignal` used for cooperative, checkpoint-only
 *   cancellation. Deadlines can be composed at the call site with
 *   `AbortSignal.timeout()` / `AbortSignal.any()` where the runtime supports
 *   them; cordis core intentionally does not add its own timeout option.
 */
export interface WaterfallOptions {
  signal?: AbortSignal | undefined
}

/**
 * The `next` function passed to waterfall listeners by
 * {@link Context.waterfallWith}. It carries the effective cancellation signal
 * (possibly `undefined` when no signal was provided) as a readonly property,
 * so already-running participants can observe it and pass it to abort-aware
 * APIs. Handlers that treat `next` as a plain function are unaffected.
 */
export interface WaterfallNext<T = any> {
  (): T
  /**
   * The effective `AbortSignal` for the current invocation, or `undefined` if
   * none was provided. Note that this is a snapshot for cooperative checks; it
   * never aborts on its own unless the caller's signal does.
   */
  readonly signal: AbortSignal | undefined
}

function abortReason(signal: AbortSignal): any {
  // Node 18+/modern browsers expose `reason`; fall back for older runtimes.
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

export interface EventOptions {
  prepend?: boolean
  global?: boolean
}

export interface Hook extends EventOptions {
  ctx: Context
  callback: (...args: any[]) => any
}

export class EventsService {
  _hooks: Record<keyof any, Hook[]> = Object.create(null)

  constructor(private ctx: Context) {
    defineProperty(this, symbols.tracker, {
      property: 'ctx',
      noShadow: true,
    })

    this.on('internal/listener', function (this: Context, name, listener, options: EventOptions) {
      if (name === 'internal/update' && !options.global) {
        const hooks = this.fiber._hooks['internal/update'] ??= new DisposableList()
        const method = options.prepend ? 'unshift' : 'push'
        return hooks[method](listener)
      }
    })

    this.on('internal/update', function (config, noSave, next) {
      const cbs = [...this._hooks['internal/update'] || []]
      const _next = () => {
        const cb = cbs.shift() ?? next
        return cb.call(this, config, noSave, _next)
      }
      return _next()
    }, { global: true, prepend: true })
  }

  private _resolve(type: string, args: any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name: string | symbol = args.shift()
    if ((typeof name !== 'string' || !name.startsWith('internal/')) && this._hooks['internal/dispatch']?.length) {
      this.emit('internal/dispatch', type, name, args, thisArg)
    }
    const filter = thisArg?.[Context.filter]
    return [thisArg, (this._hooks[name] || [])
      .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx)).map(hook => hook.callback)] as const
  }

  /** @deprecated */
  dispatch(type: string, args: any[]) {
    const [thisArg, callbacks] = this._resolve(type, args)
    return callbacks.map(callback => callback.bind(thisArg))
  }

  async parallel(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('emit', args)
    const results = await Promise.allSettled(callbacks.map(async callback => Reflect.apply(callback, thisArg, args)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map(error => error.reason))
  }

  emit(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('emit', args)
    for (const callback of callbacks) Reflect.apply(callback, thisArg, args)
  }

  async serial(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('serial', args)
    for (const callback of callbacks) {
      const result = await Reflect.apply(callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  bail(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('bail', args)
    for (const callback of callbacks) {
      const result = Reflect.apply(callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  waterfall(...args: any[]) {
    const [thisArg, callbacks] = this._resolve('waterfall', args)
    const inner = args.pop()
    const dispatch = () => {
      const callback = callbacks.shift()
      if (!callback) return inner()
      let called = false
      const next = () => {
        if (called) throw new Error('next() called multiple times')
        called = true
        return dispatch()
      }
      return Reflect.apply(callback, thisArg, [...args, next])
    }
    return dispatch()
  }

  /**
   * Cancellation-aware variant of {@link Context.waterfall} implementing the
   * **checkpoint-only** cancellation model (proposal for cordiverse/cordis#43):
   *
   * - If `options.signal` is already aborted before dispatch, or aborts before
   *   a later `next()` boundary, no additional middleware or the final handler
   *   is entered.
   * - The invocation settles only once the currently running participant
   *   settles: cordis cannot forcibly terminate a running Promise, timer, or
   *   network request. Already-started participants run to completion and
   *   should cooperate by observing `next.signal` and passing it to
   *   abort-aware APIs.
   * - When an abort checkpoint is reached, the invocation rejects with the
   *   signal's abort reason (typically the value passed to `aborter.abort()`,
   *   or a `DOMException` named `AbortError` by default).
   * - With no signal (or a never-aborted one), behavior is identical to
   *   `waterfall()`, including synchronous short-circuit semantics.
   */
  waterfallWith(...args: any[]) {
    const options: WaterfallOptions = args.shift()
    const [thisArg, callbacks] = this._resolve('waterfall', args)
    const signal = options?.signal
    const inner = args.pop()
    const check = () => {
      if (signal?.aborted) throw abortReason(signal)
    }
    const dispatch = () => {
      check()
      const callback = callbacks.shift()
      if (!callback) return inner()
      let called = false
      const next = () => {
        if (called) throw new Error('next() called multiple times')
        called = true
        return dispatch()
      }
      Object.defineProperty(next, 'signal', { value: signal, writable: false, enumerable: false, configurable: false })
      return Reflect.apply(callback, thisArg, [...args, next])
    }
    return dispatch()
  }

  private register(label: string, name: string | symbol, callback: any, options: EventOptions): () => void {
    const method = options.prepend ? 'unshift' : 'push'
    return this.ctx.fiber.effect(() => {
      const hooks = this._hooks[name] ??= []
      hooks[method]({ ctx: this.ctx, callback, ...options })
      return () => this.unregister(name, callback)
    }, label)
  }

  private unregister(name: string | symbol, callback: any) {
    const hooks = this._hooks[name]
    if (!hooks) return
    const index = hooks.findIndex(hook => hook.callback === callback)
    if (index >= 0) {
      hooks.splice(index, 1)
      if (!hooks.length) delete this._hooks[name]
      return true
    }
  }

  on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }

    // handle special events
    this.ctx.fiber.assertActive()
    listener = this.ctx.reflect.bind(listener)
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result

    const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
    return this.register(label, name, listener, options)
  }

  once(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, options)
    return dispose
  }
}

export interface Events {
  [key: symbol]: (...args: any[]) => any
  'internal/plugin'(fiber: Fiber): void
  'internal/status'(fiber: Fiber, oldValue: FiberState): void
  'internal/service'(this: Context, name: string, value: any): void
  'internal/update'(this: Fiber, config: any, noSave: boolean, next: () => Awaitable<void>): Awaitable<void>
  'internal/get'(ctx: Context, name: string, error: Error, next: () => any): any
  'internal/set'(ctx: Context, name: string, value: any, error: Error, next: () => boolean): boolean
  'internal/listener'(this: Context, name: string, listener: any, prepend: boolean): void
  'internal/dispatch'(mode: DispatchMode, name: string | symbol, args: any[], thisArg: any): void
}
