import pkg from '../package.json' with { type: 'json' }

const { version } = pkg

/** Node's private resolution caches, captured once per thread. */
export interface Captured {
  resolve?: Map<unknown, unknown>
  realpath: {
    esm?: Map<unknown, unknown>
    /** may be the ESM one */
    cjs?: Map<unknown, unknown>
  }
}

/**
 * The state of loader-utils in this thread, shared by every evaluation of
 * the same version, such as one after HMR evicts loader-utils.
 */
export interface State {
  version: string
  captured?: Captured
}

const key = Symbol.for('cordis.loader-utils')

/** @returns the state, or `undefined` if another version of loader-utils created it. */
export function getState(): State | undefined {
  const state: State = (globalThis as any)[key] ??= { version }
  if (state.version === version) return state
}
