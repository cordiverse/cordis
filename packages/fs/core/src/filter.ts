import picomatch from 'picomatch'
import type { WatchFilter } from './watcher.ts'

// whether `path` is `base` or lies below it
function contains(base: string, path: string) {
  return !base || path === base || path.startsWith(base + '/')
}

// whether `match` matches `path` or one of its ancestors
function matchesUpward(match: (path: string) => boolean, path: string) {
  for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
    if (match(path.slice(0, end))) return true
  }
  return false
}

// The POSIX normalization of a relative pattern: `.` and empty segments are
// removed, and `..` removes the preceding segment. `undefined` for a pattern
// that leads outside the watched directory.
function normalize(pattern: string) {
  if (pattern.startsWith('/')) return
  const segments: string[] = []
  for (const segment of pattern.split('/')) {
    if (!segment || segment === '.') continue
    if (segment !== '..') {
      segments.push(segment)
    } else if (!segments.pop()) {
      return
    }
  }
  return segments.join('/') || '.'
}

interface Rule {
  negated: boolean
  match: (path: string) => boolean
  /** the directory before the first glob segment, empty for the watched directory */
  base: string
  /** whether the ancestors of an entry are tested */
  upward: boolean
}

/**
 * Convert `filter` of `WatchOptions` into a predicate on the paths below the
 * watched directory, relative to it and separated by `/`. A predicate is
 * returned as it is. An entry of an array that leads outside the watched
 * directory throws a `TypeError`.
 */
export function createFilter(filter: WatchFilter): (path: string, isDirectory: boolean) => boolean {
  if (typeof filter === 'function') return filter
  const rules = filter.map<Rule>((entry) => {
    const negated = entry.startsWith('!')
    const pattern = normalize(negated ? entry.slice(1) : entry)
    if (pattern === undefined) {
      throw new TypeError(`filter entry ${JSON.stringify(entry)} leads outside the watched directory`)
    }
    // compared with real paths, so the escapes are removed
    const { base } = picomatch.scan(pattern, { unescape: true })
    return {
      negated,
      // `.` is the watched directory, which no path below it matches.
      // `posix` makes `[!...]` a negated bracket expression, as in POSIX.
      match: pattern === '.' ? () => true : picomatch(pattern, { posix: true }),
      base: base === '.' ? '' : base,
      upward: true,
    }
  })
  // Below an entry excluded with no including pattern after it, no entry is
  // reached, so the ancestors need not be tested.
  for (let index = rules.length - 1; index >= 0 && rules[index].negated; index--) {
    rules[index].upward = false
  }
  return (path, isDirectory) => {
    // The last pattern that matches the entry or one of its ancestors decides.
    let index = rules.length
    while (index--) {
      const { match, upward } = rules[index]
      if (upward ? matchesUpward(match, path) : match(path)) break
    }
    if (index >= 0 && !rules[index].negated) return true
    // A directory is kept if a later including pattern may lead below it.
    return isDirectory && rules.some(({ negated, base }, i) => {
      return i > index && !negated && (contains(base, path) || contains(path, base))
    })
  }
}
