import { Dict } from 'cosmokit'

/** The dependency fields that an installation reads. `peerDependencies` is not one of them. */
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

// the rules of `validate-npm-package-name` for new packages, with legacy upper-case letters
const NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

/**
 * name → spec. A spec is written to the manifest as it is; `null` removes
 * the dependency.
 */
export type DependencyChanges = Dict<string | null>

export function normalizeChanges(changes: DependencyChanges | [string, string | null][]) {
  const entries = Array.isArray(changes) ? changes : Object.entries(changes)
  const result: [string, string | null][] = []
  for (const [name, spec] of entries) {
    if (typeof name !== 'string' || name.length > 214 || !NAME.test(name)) {
      throw new TypeError(`invalid package name "${name}"`)
    }
    if (spec !== null && (typeof spec !== 'string' || !spec.trim())) {
      throw new TypeError(`invalid spec for "${name}", expected a non-empty string or null`)
    }
    result.push([name, spec])
  }
  return result
}

function isSorted(keys: string[]) {
  return keys.every((key, index) => !index || keys[index - 1].localeCompare(key, 'en') <= 0)
}

/**
 * Apply the changes to a manifest object. A dependency is updated in every
 * field that declares it, and is added to `dependencies` otherwise. A
 * removed dependency is removed from every field. A field whose keys were
 * sorted stays sorted.
 */
export function applyChanges(manifest: any, changes: [string, string | null][]) {
  const sorted = new Set(FIELDS.filter(field => manifest[field] && isSorted(Object.keys(manifest[field]))))
  for (const [name, spec] of changes) {
    if (spec === null) {
      for (const field of FIELDS) delete manifest[field]?.[name]
      continue
    }
    const fields = FIELDS.filter(field => manifest[field] && Object.hasOwn(manifest[field], name))
    if (!fields.length) {
      manifest.dependencies ??= {}
      fields.push('dependencies')
    }
    for (const field of fields) manifest[field][name] = spec
  }
  for (const field of sorted) {
    const entries = Object.entries(manifest[field]).sort(([a], [b]) => a.localeCompare(b, 'en'))
    manifest[field] = Object.fromEntries(entries)
  }
  return manifest
}

/** Serialize a manifest with the indentation and line endings of its original text. */
export function stringifyManifest(manifest: any, original: string) {
  const indent = /^[{[]\r?\n([ \t]+)/.exec(original)?.[1] ?? 2
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let text = JSON.stringify(manifest, null, indent)
  if (eol !== '\n') text = text.replace(/\n/g, eol)
  if (/\r?\n$/.test(original)) text += eol
  return text
}
