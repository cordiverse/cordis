import pkg from '../../package.json' with { type: 'json' }
import type { ManifestState } from './manifests.ts'

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
 * The state of the runtime in this thread, shared by every evaluation of the
 * same version of HMR, such as one after HMR itself is reloaded.
 */
export interface State {
  version: string
  captured?: Captured
  /** set once the manifest readers are replaced */
  manifests?: ManifestState
}

const key = Symbol.for('cordis.hmr.runtime')

/** @returns the state, or `undefined` if another version of HMR created it. */
export function getState(): State | undefined {
  const state: State = (globalThis as any)[key] ??= { version }
  if (state.version === version) return state
}
