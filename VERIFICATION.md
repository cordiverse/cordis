# Verification

What each requirement of this work is backed by, where it lives, and what is still unverified. The goal is that nothing here has to be taken on the author's word.

## 1. Node source-level verification

Every behaviour this work depends on is checked against the Node source (v24.15.0, with v22.22.2 for comparison), not against probe output alone.

| Behaviour | Source | What it says |
|---|---|---|
| `loadCache` entries are slots, and `delete` only clears a slot | `lib/internal/modules/esm/module_map.js:93-127` | `delete(url, type)` does `cached[type] = undefined`; the entry stays. Hence `Map.prototype.delete.call(loadCache, url)` in `cache.ts`. |
| v22 has the same slot shape | `module_map.js` at v22.22.2 | Identical `get/set/delete(url, type, job)`. The older comment claiming v22 was a plain `Map` was wrong and is gone. |
| `relativeResolveCache` runs before resolution | `lib/internal/modules/cjs/loader.js:1239-1262` | `Module._load` checks `${parent.path}\x00${request}` at L1247 and returns the cached module at L1255, before `resolveForCJSWithHooks` at L1260. |
| Both resolution paths end at `Module._resolveFilename` | `cjs-loader.js:1054`, `:1061`, `:1392` | The hook path and the fast path both reach it (`node:` builtins excepted), which is why the patch covers `require`. |
| `nearest-manifest` lookup is two private `SafeMap`s | `lib/internal/modules/package_json_reader.js:149`, `:159`, `:166-169` | `moduleToParentPackageJSONCache` and `deserializedPackageJSONCache`; no public way to clear them. |
| The native reader has no `clear` | `package_json_reader.js` (all `modulesBinding.*` calls) | Only `getNearestParentPackageJSON`, `getPackageScopeConfig`, `getPackageType`, `readPackageJSON` — all reads. |
| `Module._pathCache` cannot help | `cjs-loader.js:353`, `:713`, `:803` | It caches `request + parent → filename`; clearing it re-resolves, and the re-resolution still reads the stale manifest. |
| `registerHooks` exists on both versions | runtime check on v22.22.2 and v24.15.0 | Both `typeof require('node:module').registerHooks === 'function'`. |

## 2. Differential tests (the main correctness judge)

`packages/hmr/tests/differential.spec.ts` runs each scenario twice in separate processes — once along the HMR path (load, change, reconcile) and once as a cold start (change, then load) — and requires the observable state to agree.

| Scenario | What changes | Result |
|---|---|---|
| `entry` | a leaf dependency | replaced 1, same value |
| `shared` | one dependency behind two plugins | replaced 2, both observe it |
| `roots` | a package subtree | replaced 1 |
| `fix` | break, then repair | aborts first, replaced 1 after the fix |
| `cjs` | a CommonJS module | replaced 1 |
| `json` | a JSON module | replaced 1 |
| `add` | the plugin switches to a new dependency | replaced 1 |
| `main` | a package's `main` moves | replaced 1 |
| `churn` | same `roots` twice | replaced 0 the second time |
| `middle` | a module in the middle of a chain | replaced 1, both re-evaluated |
| `type` | a flipped `type` (plain process, so the load hook is called) | replaced 1, loaded under the new format |
| `delete` | a dependency removed and no longer imported | replaced 1 |
| `multi` | one unit breaks, the other commits | aborted 1, replaced 1; after the fix both match a cold start |
| `host` | a change inside the entry's own closure | the engine reports `restartReason`, and the cold start shows the restart gives the right value |

Every change kind is compared. A host change is compared in a different form: the host is whatever the process entry's closure holds, so the scenario generates an entry that imports the fixture and runs it as its own process; the assertion is then "a restart is required" against "a restart gives the right state", rather than state equality. A dependency under `node_modules` reached through `exports` is covered by `reconcile.spec.ts`, not here: the loader's own entry resolution does not load such a fixture in this harness.

Mechanism: the harness bundles the workspace with esbuild into one file (`__probe__/differential.mjs` imports it). A translating loader such as `tsx` keeps modules in its own cache rather than Node's `loadCache`, so the engine finds no plugin to reload — measured as `replaced: 0` for every scenario. The child process needs `--expose-internals`, or the optional `node-addon-require-builtin`, or there is no module cache to evict.

## 3. Property tests

`packages/hmr/tests/unit-property.spec.ts` runs 200 random graphs (deterministic PRNG, replayable seed) and asserts four theorems: the partition is the connected components of the "changed sets intersect" relation; scopes are pairwise disjoint; a module nothing reaches is in no scope; every unit's scope contains its entries. The grouping oracle is an independent union-find. A mutation check (comparing only against the first stale) shows the first property is not vacuous — it fails on 11 pairs.

## 4. Cost

`packages/hmr/tests/bench.spec.ts`, 20 rounds each, p50:

| Measurement | Result |
|---|---|
| `collectDependencies`, 1000 nodes | 0.29 ms (p95 0.87) |
| `collectDependencies`, 10000 nodes | 3.33 ms (p95 4.18) — linear |
| `groupUnits`, 1000 stales × 100-module closures | 22.53 ms (p95 25.70) |
| Eviction operations, old vs new | 100000 vs 32713 — 67.3% fewer |

Honest limits: the benchmark's `linked` is a plain array (real Node may hand a promise, so the numbers are a lower bound), and the eviction row counts operations rather than time.

## 5. Memory

`packages/hmr/tests/cache-memory.spec.ts` pins the leak that was found and fixed: `ModuleCache` kept every backup forever, because a committed transaction never restores. Backups are now dropped by `restore(owner)` and cleared when the transaction ends.

## 6. Engineering self-check

Each PR in this series carries a `Self-check` section: no regression, not a half fix, not a platform no-op, no unreachable guard, no contributor test deleted, not superseded, no force push over a contributor branch. These are general criteria, not a house style.

## 7. Decisions (ADR)

**A. Narrow the eviction to what a change reaches.**
Alternatives: evict each stale entry's whole dependency tree (what the paper's Algorithm 9/10 describe). Cost: the reverse edges must be walked, which now happens inside the two walks that already read them. Reason: an unchanged module's loading effect has already been applied and has nothing to undo — re-evaluating it would run its side effects twice (Section 6.4), and an unchanged shared module would otherwise join two units.

**B. Roll back per unit.**
Alternatives: one backup for the batch (Algorithm 10). Cost: a per-owner backup, a per-unit stage 1, and a slightly larger `Result`. Reason: the issue asks that one broken package not hold back an unrelated update; the paper's Theorem 43 covers the result once the units are pairwise independent, which is what the disjoint-scope lemma supplies.

**C. Answer a flipped `type` with a load hook, verified in a plain process.**
Alternatives: no hook (a flipped package needs a restart), or the resolve hook's `format` field (measured: not taken). Cost: the test runner never calls load hooks, so the case has to run in a child process. Reason: the hook works in the shape the code actually runs in.

**D. Serve `require` through `Module._resolveFilename`.**
Alternatives: rely on the resolve hook alone (measured unreliable on macOS). Cost: a patch of an internal function. Reason: the source shows `relativeResolveCache` sits *before* the hook path, and `_resolveFilename` is the point both paths share.

**E. Bypass the manifest reader instead of clearing it.**
Alternatives: clear the native reader, the nearest-manifest cache, the ESM resolve cache, the CJS path cache. Cost: one set lookup per resolution. Reason: the reader is outside the system boundary of Section 6.1 — it can neither be modified exclusively nor restored — and the source shows no `clear` on any of the four binding entry points. Reification is the paper's own move for such a location.

## 8. Downstream audit

- `ctx.hmr`: no consumer inside this repository outside the hmr package itself.
- `hmr/reload`: only tests listen to it.
- `Hmr.Result`: only tests reference the type.
- **Breaking changes**: `Result.aborted` is now `Abort[]` instead of `{ error }`; `registry.replace` returns `Map<Fiber, Error>` instead of the target runtime; `ModuleCache.evict/restore` take an owner (internal to the hmr package).
- Downstreams outside this repository cannot be audited from here; the three changes above are the ones that would affect them.

## 9. Where each change comes from

Every PR in the series carries a `Where this comes from` section pointing at the paper: Algorithms 8/9/10 and Section 5.2.2 for the engine, Definition 42 and Theorem 43 for per-unit independence, Section 3.3.2 for `≃`, Sections 4.1/4.3/4.4/5.1 for the fiber lifecycle and failure semantics, Section 6.1 for the system boundary, Section 6.4 for loading-as-effect and the two module systems, Sections 6.5/6.6 for granularity and versioning. The two places the paper does not cover — the narrowed eviction and the per-unit rollback — are proved in the PR body (witness, disjoint scopes, and the optimality of the partition) rather than cited.

## Unverified

- **No change kind is left uncompared.** A host change uses a different comparison form (see above), and the two kinds that need a `node_modules` fixture are covered by `reconcile.spec.ts` instead of this harness.
- **A repeated `files` reconcile** is a semantic case rather than a gap — `files` always applies, so it is the control (`churn`) that uses `roots`.
- **The benchmark's `linked` is a mock**, so the timings are a lower bound; the eviction comparison counts operations, not time.
- **200 random graphs are not an exhaustive proof**; they exercise the four properties, and the mutation check shows they can fail.
- **Node 22 is outside the CI matrix.** The differential harness was run on 22 locally, which is how two of the bugs in this series were found, but CI only runs 24 and 26.
- **The paper was read for the parts this work touches** (Sections 3.1–3.4, 4.1, 4.3, 4.4, 5.1, 5.2.2, 6.1, 6.4–6.6), not in full.
- **item 5 (installer/manager services) is not implemented.** The issue asks for its own design discussion; a design note exists, including the two constraints Section 6.6 imposes (peer dependencies, and single-version resolution).
