import { defineProperty } from 'cosmokit'
import type { Context, Service } from '.'

export class DisposableList<T> {
  private sn = 0
  private map = new Map<number, T>()

  get length() {
    return this.map.size
  }

  push(value: T) {
    this.map.set(++this.sn, value)
    return () => this.map.delete(this.sn)
  }

  _leak(value: T) {
    const v = this.map.get(this.sn)
    if (v !== value) return false
    return this.map.delete(this.sn)
  }

  clear() {
    const values = [...this.map.values()]
    this.map.clear()
    return values.reverse()
  }

  [Symbol.iterator]() {
    return this.map.values()
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return [...this]
  }
}

export interface Tracker {
  associate?: string
  property?: string
  noShadow?: boolean
}

export const symbols = {
  // internal symbols
  shadow: Symbol.for('cordis.shadow'),
  receiver: Symbol.for('cordis.receiver'),
  original: Symbol.for('cordis.original'),
  initHooks: Symbol.for('cordis.initHooks'),

  // context symbols
  init: Symbol.for('cordis.init') as typeof Context.init,
  store: Symbol.for('cordis.store') as typeof Context.store,
  effect: Symbol.for('cordis.effect') as typeof Context.effect,
  events: Symbol.for('cordis.events') as typeof Context.events,
  filter: Symbol.for('cordis.filter') as typeof Context.filter,
  isolate: Symbol.for('cordis.isolate') as typeof Context.isolate,
  internal: Symbol.for('cordis.internal') as typeof Context.internal,
  intercept: Symbol.for('cordis.intercept') as typeof Context.intercept,

  // service symbols
  check: Symbol.for('cordis.check') as typeof Service.check,
  invoke: Symbol.for('cordis.invoke') as typeof Service.invoke,
  extend: Symbol.for('cordis.extend') as typeof Service.extend,
  tracker: Symbol.for('cordis.tracker') as typeof Service.tracker,
}

const GeneratorFunction = function* () {}.constructor
const AsyncGeneratorFunction = async function* () {}.constructor

export function isConstructor(func: any): func is new (...args: any) => any {
  // async function or arrow function
  if (!func.prototype) return false
  // generator function or malformed definition
  // we cannot use below check because `mock.fn()` is proxified
  // if (func.prototype.constructor !== func) return false
  if (func instanceof GeneratorFunction) return false
  // polyfilled AsyncGeneratorFunction === Function
  if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false
  return true
}

export function isUnproxyable(value: any) {
  return [Map, Set, Date, Promise].some(constructor => value instanceof constructor)
}

export function joinPrototype(proto1: {}, proto2: {}) {
  if (proto1 === Object.prototype) return proto2
  const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2))
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key)!)
  }
  return result
}

export function isObject(value: any): value is {} {
  return value && (typeof value === 'object' || typeof value === 'function')
}

export function getPropertyDescriptor(target: any, prop: string | symbol) {
  let proto = target
  while (proto) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, prop)
    if (desc) return desc
    proto = Object.getPrototypeOf(proto)
  }
}

export function getTraceable<T>(ctx: Context, value: T): T {
  if (!isObject(value)) return value
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value)
  }
  const tracker = value[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker)
}

export function withProps(target: any, props?: {}) {
  if (!props) return target
  return new Proxy(target, {
    get: (target, prop, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.get(props, prop, receiver)
      return Reflect.get(target, prop, receiver)
    },
    set: (target, prop, value, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.set(props, prop, value, receiver)
      return Reflect.set(target, prop, value, receiver)
    },
  })
}

function withProp(target: any, prop: string | symbol, value: any) {
  return withProps(target, Object.defineProperty(Object.create(null), prop, {
    value,
    writable: false,
  }))
}

function createShadow(ctx: Context, target: any, property: string | undefined, receiver: any) {
  if (!property) return receiver
  const origin = Reflect.getOwnPropertyDescriptor(target, property)?.value
  if (!origin) return receiver
  return withProp(receiver, property, ctx.extend({ [symbols.shadow]: origin }))
}

function createShadowMethod(ctx: Context, value: any, outer: any, shadow: {}) {
  return new Proxy(value, {
    apply: (target, thisArg, args) => {
      if (thisArg === outer) thisArg = shadow
      return getTraceable(ctx, Reflect.apply(target, thisArg, args))
    },
  })
}

function createTraceable(ctx: Context, value: any, tracker: Tracker) {
  if (ctx[symbols.shadow]) {
    ctx = Object.getPrototypeOf(ctx)
  }
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      if (prop === symbols.original) return target
      if (prop === tracker.property) return ctx
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      if (tracker.associate && ctx[symbols.internal][`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver))
      }
      let shadow: any, innerValue: any
      const desc = getPropertyDescriptor(target, prop)
      if (desc && 'value' in desc) {
        innerValue = desc.value
      } else {
        shadow = createShadow(ctx, target, tracker.property, receiver)
        innerValue = Reflect.get(target, prop, shadow)
      }
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) {
        return createTraceable(ctx, innerValue, innerTracker)
      } else if (!tracker.noShadow && typeof innerValue === 'function') {
        shadow ??= createShadow(ctx, target, tracker.property, receiver)
        return createShadowMethod(ctx, innerValue, receiver, shadow)
      } else {
        return innerValue
      }
    },
    set: (target, prop, value, receiver) => {
      if (prop === symbols.original) return false
      if (prop === tracker.property) return false
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver)
      }
      if (tracker.associate && ctx[symbols.internal][`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver))
      }
      const shadow = createShadow(ctx, target, tracker.property, receiver)
      return Reflect.set(target, prop, value, shadow)
    },
    apply: (target, thisArg, args) => {
      return applyTraceable(proxy, target, thisArg, args)
    },
  })
  return proxy
}

function applyTraceable(proxy: any, value: any, thisArg: any, args: any[]) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args)
  return value[symbols.invoke].apply(proxy, args)
}

export function createCallable(name: string, proto: {}, tracker: Tracker) {
  const self = function (...args: any[]) {
    const proxy = createTraceable(self['ctx'], self, tracker)
    return applyTraceable(proxy, self, this, args)
  }
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}

export async function composeError<T>(callback: () => Promise<T>, innerOffset: number, getOuterStack: () => Iterable<string>) {
  // force async stack trace
  await Promise.resolve()

  try {
    return await callback()
  } catch (error: any) {
    const innerError = new Error()
    const innerLines = innerError.stack!.split('\n')

    // malformed error
    if (typeof error?.stack !== 'string') {
      const outerError = new Error(error)
      const lines = outerError.stack!.split('\n')
      lines.splice(1, Infinity, ...getOuterStack())
      outerError.stack = lines.join('\n')
      throw outerError
    }

    // long stack trace
    const lines: string[] = error.stack.split('\n')
    const index = lines.indexOf(innerLines[2])
    if (index === -1) throw error

    lines.splice(index - innerOffset, Infinity)
    lines.push(...getOuterStack())
    error.stack = lines.join('\n')
    throw error
  }
}
