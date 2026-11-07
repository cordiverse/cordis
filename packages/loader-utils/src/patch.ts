/**
 * Replace a method of Node permanently. A function that restores the original
 * method while the replacement is still in place is appended to `restores`
 * before this returns, so that a partial installation can be rolled back.
 */
export function install<T extends object, K extends keyof T>(restores: (() => void)[], target: T, key: K, replacement: T[K]) {
  const original = target[key]
  target[key] = replacement
  restores.push(() => {
    if (target[key] === replacement) target[key] = original
  })
}
