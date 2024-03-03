import { defineProperty } from 'cosmokit'
import type { Context, Service } from './index.ts'

export const symbols = {
  // context symbols
  origin: Symbol.for('cordis.origin') as typeof Context.origin,
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
  provide: Symbol.for('cordis.provide') as typeof Service.provide,
  immediate: Symbol.for('cordis.immediate') as typeof Service.immediate,
}

export function isConstructor(func: any): func is new (...args: any) => any {
  // async function or arrow function
  if (!func.prototype) return false
  // generator function or malformed definition
  if (func.prototype.constructor !== func) return false
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

export function createTraceable(ctx: any, value: any) {
  const proxy = new Proxy(value, {
    get: (target, name, receiver) => {
      if (name === symbols.origin || name === 'caller') return ctx
      return Reflect.get(target, name, receiver)
    },
    apply: (target, thisArg, args) => {
      return applyTraceable(proxy, target, thisArg, args)
    },
  })
  return proxy
}

export function applyTraceable(proxy: any, value: any, thisArg: any, args: any[]) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args)
  return value[symbols.invoke].apply(proxy, args)
}

export function createCallable(name: string, proto: {}) {
  const self = function (...args: any[]) {
    const proxy = createTraceable(self[symbols.origin], self)
    return applyTraceable(proxy, self, this, args)
  }
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}
