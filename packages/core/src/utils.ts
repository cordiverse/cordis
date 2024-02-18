import { defineProperty } from 'cosmokit'
import type { Context, Service } from './index.ts'

export const kTrace = Symbol.for('cordis.trace') as typeof Context.trace
export const kInvoke = Symbol.for('cordis.invoke') as typeof Service.invoke

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

export function appendFunctionPrototype(proto: {}) {
  if (proto === Object.prototype) return Function.prototype
  const result = Object.create(appendFunctionPrototype(Object.getPrototypeOf(proto)))
  for (const key of Reflect.ownKeys(proto)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto, key)!)
  }
  return result
}

export function createTraceable(ctx: any, value: any) {
  const proxy = new Proxy(value, {
    get: (target, name, receiver) => {
      if (name === kTrace || name === 'caller') return ctx
      return Reflect.get(target, name, receiver)
    },
    apply: (target, thisArg, args) => {
      return applyTraceable(proxy, target, thisArg, args)
    },
  })
  return proxy
}

export function applyTraceable(proxy: any, value: any, thisArg: any, args: any[]) {
  if (!value[kInvoke]) return Reflect.apply(value, thisArg, args)
  return value[kInvoke].apply(proxy, args)
}

export function createCallable(name: string, proto: {}) {
  const self = function (...args: any[]) {
    const proxy = createTraceable(self[kTrace], self)
    return applyTraceable(proxy, self, this, args)
  }
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}
