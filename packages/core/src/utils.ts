import { defineProperty } from 'cosmokit'
import type { Context, Service } from './index.ts'

export interface Tracker {
  associate?: string
  property?: string
}

export const symbols = {
  // internal symbols
  shadow: Symbol.for('cordis.shadow'),
  receiver: Symbol.for('cordis.receiver'),

  // context symbols
  source: Symbol.for('cordis.source') as typeof Context.source,
  events: Symbol.for('cordis.events') as typeof Context.events,
  static: Symbol.for('cordis.static') as typeof Context.static,
  filter: Symbol.for('cordis.filter') as typeof Context.filter,
  expose: Symbol.for('cordis.expose') as typeof Context.expose,
  isolate: Symbol.for('cordis.isolate') as typeof Context.isolate,
  internal: Symbol.for('cordis.internal') as typeof Context.internal,
  intercept: Symbol.for('cordis.intercept') as typeof Context.intercept,

  // service symbols
  setup: Symbol.for('cordis.setup') as typeof Service.setup,
  invoke: Symbol.for('cordis.invoke') as typeof Service.invoke,
  extend: Symbol.for('cordis.extend') as typeof Service.extend,
  tracker: Symbol.for('cordis.tracker') as typeof Service.tracker,
  provide: Symbol.for('cordis.provide') as typeof Service.provide,
  immediate: Symbol.for('cordis.immediate') as typeof Service.immediate,
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

export function resolveConfig(plugin: any, config: any) {
  const schema = plugin['Config'] || plugin['schema']
  if (schema && plugin['schema'] !== false) config = schema(config)
  return config ?? {}
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

export function getTraceable<T>(ctx: Context, value: T, noTrap?: boolean): T {
  if (!isObject(value)) return value
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value)
  }
  const tracker = value[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker, noTrap)
}

function createShadowMethod(ctx: Context, value: any, outer: any, property: string) {
  return new Proxy(value, {
    apply: (target, thisArg, args) => {
      const isBound = thisArg === outer

      // contravariant
      thisArg = new Proxy(thisArg, {
        get: (target, prop, receiver) => {
          if (prop === property && isBound) {
            const origin = Reflect.getOwnPropertyDescriptor(target, prop)?.value
            return ctx.extend({ [symbols.shadow]: origin })
          }
          return Reflect.get(target, prop, receiver)
        },
        set: (target, prop, value, receiver) => {
          if (prop === property) return false
          return Reflect.set(target, prop, value, receiver)
        },
      })

      // contravariant
      args = args.map((arg) => {
        if (typeof arg !== 'function') return arg
        return new Proxy(arg, {
          apply: (target: Function, thisArg, args) => {
            // covariant
            return Reflect.apply(target, getTraceable(ctx, thisArg), args.map(arg => getTraceable(ctx, arg)))
          },
        })
      })

      // covariant
      return getTraceable(ctx, Reflect.apply(target, thisArg, args))
    },
  })
}

// covariant
function createTraceable(ctx: Context, value: any, tracker: Tracker, noTrap?: boolean) {
  if (ctx[symbols.shadow]) {
    ctx = Object.getPrototypeOf(ctx)
  }
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      if (prop === tracker.property) return ctx
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      if (tracker.associate && ctx[symbols.internal][`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, new Proxy(ctx, {
          get: (target2, prop2, receiver2) => {
            if (prop2 === symbols.receiver) return receiver
            return Reflect.get(target2, prop2, receiver2)
          },
        }))
      }
      const innerValue = Reflect.get(target, prop, receiver)
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) {
        return createTraceable(ctx, innerValue, innerTracker)
      } else if (!noTrap && tracker.property && typeof innerValue === 'function') {
        return createShadowMethod(ctx, innerValue, receiver, tracker.property)
      } else {
        return innerValue
      }
    },
    set: (target, prop, value, receiver) => {
      if (prop === tracker.property) return false
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver)
      }
      if (tracker.associate && ctx[symbols.internal][`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, new Proxy(ctx, {
          get: (target2, prop2, receiver2) => {
            if (prop2 === symbols.receiver) return receiver
            return Reflect.get(target2, prop2, receiver2)
          },
        }))
      }
      return Reflect.set(target, prop, value, receiver)
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

export function createMixin(service: {}, receiver: any) {
  return receiver ? new Proxy(receiver, {
    get: (target, prop, receiver) => {
      if (prop in service) return Reflect.get(service, prop, receiver)
      return Reflect.get(target, prop, receiver)
    },
  }) : service
}
