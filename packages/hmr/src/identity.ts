import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { relocate } from './manifest.ts'

export interface Identity {
  // the realpath, the key of the store, and the `file:` URL the module was
  // loaded from, which is what the rest of hmr speaks
  path: string
  url: string
  // read with `{ bigint: true }`: as numbers, `ino` and `mtimeNs` lose
  // precision — NTFS indices pass 2^53, where two files a step apart
  // collapse into one — and `mtimeNs` is the finest timestamp the stat offers
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  // `Date.now()`, read before the stat: file timestamps come from the same
  // realtime clock, while `performance.now()` is monotonic and not comparable
  observedAt: number
  // the content hash, recorded when the timestamps alone cannot settle the
  // question; reading content costs I/O, so it is skipped otherwise. Absent
  // when the file could not be read, which makes every later comparison report
  // a change
  hash?: string
}

// Compares module files against their recorded identity: `changed` answers
// whether a file can be proven unchanged, and what cannot be proven counts
// as changed.
export class IdentityStore {
  // realpath -> Identity. Records are kept for the process lifetime: nothing
  // proves a module left every closure, so they are never collected. A
  // long-running process can read `Hmr#reloads` to decide when a restart is
  // cheaper than the records it holds.
  private records = new Map<string, Identity>()
  // url -> realpath, so that when a file is deleted and `toPath(url)` can no
  // longer resolve via realpathSync, its record can still be found and pruned
  private _urls = new Map<string, string>()

  // `window`: how long after a write an observation of it stays suspicious,
  // in milliseconds. A record can be trusted only if no later write could
  // produce the stamp it holds, which needs the window to be at least as long
  // as the stamp is coarse. The coarsest stamp a file system Node runs on
  // produces is the two-second one of FAT32 — everything else is finer, down to
  // the 100 ns of NTFS — so two seconds is the smallest window that is correct
  // everywhere. A finer stamp only makes the window unnecessary, never wrong.
  constructor(public window = 2000) {}

  observe(url: string): Identity | undefined {
    const path = toPath(url)
    if (!path) {
      this.unobserve(url)
      return undefined
    }
    const oldPath = this._urls.get(url)
    if (oldPath && oldPath !== path) {
      this.records.delete(oldPath)
    }
    this._urls.set(url, path)

    // the clock is read before the stat, so the window covers the stat itself:
    // a write landing during it cannot make the record look settled
    const observedAt = Date.now()
    const st = this.stat(path)
    if (!st) {
      this.unobserve(url)
      return undefined
    }
    const record: Identity = {
      path,
      url,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
      observedAt,
    }
    if (!this.trustworthy(record)) {
      const hash = hashPath(path)
      // an unreadable file keeps no hash, so every later comparison reports a
      // change rather than assuming one that cannot be checked
      if (hash) record.hash = hash
    }
    this.records.set(path, record)
    return record
  }

  /**
   * The stat of a path, or undefined when it cannot be taken.
   *
   * A file system that answers with an error is treated as one that cannot be
   * read: the comparison then reports a change rather than failing a whole
   * transaction, and an observation records nothing. It is a method so that a
   * test can answer for it, since the only other way to make it fail is a race
   * between the two calls that resolve and stat the same path.
   */
  protected stat(path: string): BigIntStats | undefined {
    try {
      return statSync(path, { bigint: true })
    } catch {
      return undefined
    }
  }

  // Drop the record of a file that no longer resolves. A deleted file has no
  // identity to keep: leaving the record behind would make every later
  // `expand` report the ghost again, forever.
  private unobserve(url: string): boolean {
    const path = this._urls.get(url)
    this._urls.delete(url)
    if (path) return this.records.delete(path)
    return false
  }

  observeAll(urls: Iterable<string>) {
    for (const url of urls) this.observe(url)
  }

  changed(url: string): boolean {
    const path = toPath(url)
    // Gone, or resolving somewhere no record was made for. Nothing is left to
    // compare, and keeping the record would make every later `expand` report
    // the same ghost: a file that no longer resolves is reported once.
    if (!path) {
      this.unobserve(url)
      return true
    }
    const rec = this.records.get(path)
    // never observed: the content cannot be proven unchanged
    if (!rec) return true
    const st = this.stat(rec.path)
    // deleted since the observation
    if (!st) return true
    // a difference proves the change; the reverse does not hold, because a
    // write that lands in the same tick as the recorded one leaves all four
    // fields untouched
    if (st.dev !== rec.dev || st.ino !== rec.ino || st.size !== rec.size) return true
    if (st.mtimeNs !== rec.mtimeNs) return true
    if (this.trustworthy(rec)) return false
    const hash = hashPath(rec.path)
    return !hash || hash !== rec.hash
  }

  // Every recorded or loaded module under `root` whose content cannot be
  // proven unchanged. The directory tree is not walked: only files that are
  // already recorded or loaded can affect the runtime, so the cost is one
  // resolve and one stat per loaded module rather than per file in the tree —
  // about 77 ms for 2000 modules on Windows with Node 22 (three runs).
  expand(root: string, loaded: Iterable<string>): string[] {
    // A root that has been removed cannot be realpath'd, and the files that
    // were loaded through it are exactly what a removal has to report. The
    // path as given still names them.
    const rootPath = toPath(root) ?? toGivenPath(root)
    if (!rootPath) return []
    const candidates = new Set<string>()
    // modules that a retargeted link now reaches: their files are unchanged,
    // the package they belong to is not, so they join the batch uncompared
    const retargeted = new Set<string>()
    const collect = (url: string, path: string | undefined) => {
      if (!path) return
      if (under(path, rootPath)) {
        candidates.add(url)
        return
      }
      const moved = relocate(path)
      if (moved && under(moved, rootPath)) retargeted.add(url)
    }
    for (const rec of this.records.values()) collect(rec.url, rec.path)
    for (const url of loaded) {
      // The old real path may already be gone: the package manager can delete
      // the versioned directory before `reconcile` runs. `toPath` needs the
      // file to exist, but the URL still names the path under `node_modules`.
      const path = toPath(url) ?? toGivenPath(url)
      // loaded after the last observation: no record to compare against yet
      if (path && this.records.has(path)) continue
      collect(url, path)
    }
    return [...new Set([
      ...[...candidates].filter(url => this.changed(url)),
      ...retargeted,
    ])]
  }

  // Every URL this store holds a record for. A module can be evicted from both
  // module caches while a plugin still refers to it, so the records are the
  // only place such a module remains visible.
  urls(): string[] {
    return [...this.records.values()].map(record => record.url)
  }

  private trustworthy(rec: Identity) {
    const observedAtNs = BigInt(rec.observedAt) * 1_000_000n
    // The comparison is against the clock that read the file, not against the
    // current one. A record taken inside a stamp bucket can never tell a write
    // that landed in that bucket after it was read, so the content has to keep
    // deciding for it; re-evaluating against a later clock would only make it
    // look settled, which is the one mistake this cannot recover from.
    //
    // A stamp ahead of that clock is not settled either. The two come from
    // different clocks, and an archive or a skewed mount can hand a file a time
    // this process has not reached yet.
    if (rec.mtimeNs > observedAtNs) return false
    return observedAtNs - rec.mtimeNs > BigInt(this.window) * 1_000_000n
  }
}

function toPath(url: string) {
  try {
    return realpathSync(fileURLToPath(url))
  } catch {
    return undefined
  }
}

// the path the URL names, without asking the file system: a file that is gone
// still has one, and a root that was removed keeps matching its recorded files
function toGivenPath(url: string) {
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

function hashPath(path: string) {
  // A file that cannot be read cannot be proven unchanged: another process may
  // hold it, and a file removed between the stat and the read is gone rather
  // than unreadable. Both answer `undefined`, which the comparison reads as a
  // change.
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

function under(path: string, root: string) {
  if (path === root) return true
  // A root may be spelled with a trailing separator, or be the separator
  // itself; adding one to a root that already ends with it matches nothing.
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}
