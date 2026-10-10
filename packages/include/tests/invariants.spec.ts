import { expect, describe, it } from 'vitest'
import { applyPatches, routeJournal } from '../src/patch'
import type { Journal } from '../src/journal'

/** Deterministic PRNG, so a failure names a seed that can be replayed. */
function rng(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

let seq = 0
const nextId = () => `id${++seq}`

const NAMES = ['foo', 'bar', 'baz']

/** Flatten a tree to `[id, path]` pairs, descending into groups. */
function walk(list: any[], parent: string | null = null, out: [string, string][] = []) {
  for (const entry of list ?? []) {
    out.push([entry.id, `${parent ?? ''}${entry.id}`])
    if (entry.group && Array.isArray(entry.config)) {
      walk(entry.config, `${parent ?? ''}${entry.id}/`, out)
    }
  }
  return out
}

/** Every object reachable from a tree, by identity. */
function refs(list: any[], out = new Set<object>()) {
  for (const entry of list ?? []) {
    if (entry && typeof entry === 'object') out.add(entry)
    if (entry?.group && Array.isArray(entry.config)) refs(entry.config, out)
  }
  return out
}

function duplicates(entries: [string, string][]) {
  const seen = new Map<string, number>()
  for (const [id] of entries) seen.set(id, (seen.get(id) ?? 0) + 1)
  return [...seen].filter(([, count]) => count > 1).map(([id]) => id)
}

/**
 * `applyPatches` promises a fresh tree: it clones the file data and every
 * inserted entry, so nothing it returns aliases its inputs. These drives check
 * that contract, plus the id uniqueness the loader's flat store relies on.
 */
describe('applyPatches invariants', () => {
  it('never mutates its inputs, keeps ids unique, and drops nothing', () => {
    const failures: string[] = []

    for (let seed = 1; seed <= 1500; seed++) {
      const r = rng(seed)
      seq = 0

      const makeEntry = (depth = 0): any => {
        const entry: any = { id: nextId(), name: NAMES[Math.floor(r() * NAMES.length)] }
        if (r() < 0.25 && depth < 2) {
          entry.group = true
          entry.config = [makeEntry(depth + 1)]
        } else {
          entry.config = { v: Math.floor(r() * 10) }
        }
        return entry
      }

      const data = Array.from({ length: 1 + Math.floor(r() * 4) }, () => makeEntry())
      const existing = walk(data).map(([id]) => id)
      const patches: any[] = Array.from({ length: Math.floor(r() * 4) }, () => {
        if (r() < 0.5) return { insert: [makeEntry()] }
        const id = existing.length && r() < 0.7
          ? existing[Math.floor(r() * existing.length)]
          : nextId()
        // Overwriting `config` on a group legitimately discards its children,
        // so drive a key that cannot change the shape of the tree.
        return { id, disabled: r() < 0.5 }
      })

      const dataBefore = JSON.stringify(data)
      const patchesBefore = JSON.stringify(patches)

      const out = applyPatches(data, patches, () => {})

      if (JSON.stringify(data) !== dataBefore) failures.push(`seed ${seed}: mutated "data"`)
      if (JSON.stringify(patches) !== patchesBefore) failures.push(`seed ${seed}: mutated "patches"`)

      // The tree must own what it mounts: an inserted entry the patch still
      // holds would be shared, and editing either would change both.
      const owned = refs(out)
      for (const patch of patches) {
        for (const shared of refs(patch.insert ?? [])) {
          if (owned.has(shared)) {
            failures.push(`seed ${seed}: output aliases an inserted entry from the patch`)
            break
          }
        }
      }

      const flat = walk(out)
      const dup = duplicates(flat)
      if (dup.length) failures.push(`seed ${seed}: duplicate ids ${dup.join(',')} in ${JSON.stringify(flat)}`)

      for (const id of existing) {
        if (!flat.some(([x]) => x === id)) failures.push(`seed ${seed}: entry "${id}" disappeared`)
      }

      if (failures.length > 5) break
    }

    expect(failures).toEqual([])
  })

  it('routes a journal without duplicating an entry', () => {
    const failures: string[] = []

    for (let seed = 1; seed <= 1000; seed++) {
      const r = rng(seed)
      seq = 0

      const data: any[] = []
      for (let i = 0; i < 1 + Math.floor(r() * 3); i++) {
        const entry: any = { id: nextId(), name: 'foo', config: { v: 1 } }
        if (r() < 0.4) {
          entry.group = true
          entry.config = [{ id: nextId(), name: 'bar', config: { v: 1 } }]
        }
        data.push(entry)
      }

      const fileIds = walk(data).map(([id]) => id)
      const patches: any[] = []
      for (let i = 0; i < Math.floor(r() * 3); i++) {
        if (r() < 0.5) {
          const entry: any = { id: nextId(), name: 'baz', config: { v: 1 } }
          if (r() < 0.5) {
            entry.group = true
            entry.config = [{ id: nextId(), name: 'baz', config: { v: 1 } }]
          }
          patches.push({ insert: [entry] })
        } else if (fileIds.length) {
          patches.push({ id: fileIds[Math.floor(r() * fileIds.length)], disabled: true })
        }
      }
      if (!patches.length) continue

      const allIds = [
        ...fileIds,
        ...walk(patches.flatMap(patch => patch.insert ?? [])).map(([id]) => id),
      ]
      const journal: Journal = new Map()
      for (let i = 0, n = Math.floor(r() * 4); i < n && allIds.length; i++) {
        const id = allIds[Math.floor(r() * allIds.length)]
        if (journal.has(id)) continue
        if (r() < 0.35) journal.set(id, { kind: 'remove' } as any)
        else journal.set(id, { kind: 'upsert', created: false, changes: { disabled: r() < 0.5 } } as any)
      }
      if (!journal.size) continue

      routeJournal(journal, data, patches as any, () => {})

      // A removal routed to an insert must take that entry and no other, so the
      // combined tree may not end up holding an id twice.
      const flat = [...walk(data), ...walk(patches.flatMap(patch => patch.insert ?? []))]
      const dup = duplicates(flat)
      if (dup.length) {
        failures.push(`seed ${seed}: duplicate ids ${dup.join(',')} — journal ${JSON.stringify([...journal])}`)
      }

      if (failures.length > 5) break
    }

    expect(failures).toEqual([])
  })
})
