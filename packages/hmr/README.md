# @cordisjs/plugin-hmr

Transactional hot module replacement for Cordis. After files or packages change, HMR imports the new modules of the affected plugins and replaces the running plugins in place: a fiber keeps its identity and config, so that a reference to it, such as the return value of `ctx.plugin()`, stays valid.

HMR reaches Node.js internals through `--expose-internals` or [`node-addon-require-builtin`](https://www.npmjs.com/package/node-addon-require-builtin), and fails to start without them.

## Usage

```ts
// reload on file changes, through the `fs` service
ctx.plugin(Hmr, { watch: { enabled: true } })

// reconcile programmatically, e.g. after a package installation
const result = await ctx.hmr.reconcile(async () => {
  const { added, removed, updated } = await ctx.packageManager.install({ foo: '^2.0.0' })
  return [...added, ...removed, ...updated].flatMap(({ path, before }) => before ? [path, before.realPath] : [path])
})
```

`reconcile(callback)` runs `callback` as the body of a transaction and reconciles the roots that it resolves to: absolute paths of files or directories. Module URLs are real paths, so the caller passes the real directories under which modules were loaded. For a package, the caller also passes its location, such as a link or a directory where a package is added, since Node.js resolves package names through it.

The result reports:

- `settledFibers`: the replaced fibers; a fiber whose new plugin fails to apply is left `FAILED`;
- `importFailures`: one entry for each unit that was aborted, with its evicted modules and the error;
- `skippedHostModules`: the changed modules that can only be applied by restarting the process.

## Mechanism

A transaction runs the following steps. Transactions run one at a time, and one started from within the running transaction is rejected.

1. **Sweep.** Module jobs that failed to load, link or evaluate are removed, so that the next import of their modules tries again.
2. **Resolution caches.** Later resolutions observe the file system below the roots:
   - an entry of the ESM resolve cache is removed if its result or its parent lies below a root, or if it resolves a package name from below a directory to which a root adds that package as `node_modules/<name>`; a root that is a `package.json` stands for its directory;
   - the CJS path cache and the realpath caches are cleared as a whole;
   - a `package.json` at or below a root, as spelled or at the real path of its directory, is read from disk from then on.
3. **Matching.** The loaded modules of the ESM load cache and of the CJS module cache whose files are a root or lie below one are changed. A changed host module, i.e. a module that the main entry point reaches statically, and a changed native addon are reported in `skippedHostModules`.
4. **Module graph.** The edges of a module are the modules linked by its ESM jobs of every `type` attribute and the children of its CJS module. The changed modules and every module that imports one are evicted; the graph is traversed through `node_modules`.
5. **Plugin discovery.** A module exports a plugin if its ESM namespace, or the exports of its CJS module that has finished loading, unwrap to a registered plugin. A plugin is stale if its module graph contains an evicted module. Stale plugins whose closures share an evicted module form a unit.
6. **Import.** The new modules of every stale plugin are imported. A module of a plugin whose resolution step 2 removed is imported through the imports that resolved to it from modules that are not evicted, resolved again, so that an entry that has moved is followed, e.g. after a package exports another entry or a link is retargeted. If an import fails, its unit is aborted: the module caches of the unit are restored and the old plugins keep running.
7. **Replacement.** The plugins of the units that imported are replaced through `registry.replace()`, in one synchronous step, and their fibers are awaited together.

With `watch.enabled` and the `fs` service, changes below `base` that match `watch.files` are collected over `watch.debounce` milliseconds and reconciled. The files of an aborted unit are retained for the next batch.

### Replacements of Node.js methods

Node.js caches package manifests in native code and caches the file of a CJS request in a private map; neither can be cleared. When HMR starts, it replaces the methods of Node.js that read manifests and `Module._load`, which resolves a CJS request with a parent before Node.js consults its request cache. The replacements are not restored when HMR is disposed, since restoring them would expose the stale entries again. The next HMR in the thread restores them and installs its own, taking over the invalidated paths. At most one HMR instance is active in a thread.

## Limitations

### Changes that are reported instead of applied

Some changes cannot be applied in place exactly. HMR detects them and reports them in the result instead of applying them, so that the caller can decide whether to restart the process:

- a changed host module or native addon is reported in `skippedHostModules`;
- a plugin module that several imports resolved to, which now resolve to different modules, aborts its unit and is reported in `importFailures`. For example, two importers resolve `foo` to `foo@1` through their own links, and an update retargets only one of them to `foo@2`: the fibers of the plugin do not record which import each of them comes from.

The following changes are detectable in the same way, but are currently applied without a report:

- **An entry without a recorded import.** A plugin module is imported again at its previous URL if no import recorded in the ESM resolve cache resolved to it: a plugin that code which is not reloaded obtained through `require()`, e.g. `ctx.plugin(require('foo'))`, or whose import a synchronous resolve hook answered without the default resolution of Node.js. If a root covers the manifest of its package, a change that moves the entry, such as a new `exports` target or a retargeted link, is not followed.
- **Shadowing.** A package added at `<dir>/node_modules/<name>` does not change any loaded file, so a loaded module below `<dir>` that imports `<name>` statically keeps the previous package. Resolutions made after the transaction observe the added package when its location is a root.
- **A plugin that several modules export.** Its replacement is taken from one of them. If the new modules export different plugins, e.g. `a.mjs` and `b.mjs` re-exported one plugin and `b.mjs` now exports another one, the fibers registered from `b.mjs` receive the plugin of `a.mjs`.

### Requirements

- Node.js internals are reachable through `--expose-internals` or `node-addon-require-builtin`; otherwise HMR fails to start.
- ESM resolution through a retargeted link observes the new target on Node.js 24.16+ and 26.1+. On earlier versions, the ESM realpath cache cannot be obtained, and an update that retargets a link, which is every update in an isolated layout, may keep importing the previous target.
- Module hooks are synchronous, registered with `module.registerHooks()`. Asynchronous hooks registered with `module.register()` move ESM resolution to a separate thread, whose caches HMR cannot reach.
- No other code replaces `Module._load` or the methods through which Node.js reads package manifests while HMR runs. A wrapper installed before HMR receives, for a CJS request with a parent, a key that HMR derives from the resolution instead of the original request; a replacement installed after HMR that does not call it bypasses HMR, and the next HMR fails to start, since it cannot restore the methods.
- At most one HMR instance is active in a thread, and it affects the caches of that thread only, not those of worker threads.

### Other limitations

These cases are neither excluded by the requirements nor detected:

- **Results outside a package.** An entry of the ESM resolve cache is kept if its result lies outside the package whose manifest decided it. For example, a package `foo` declares `"main": "../shared/index.js"`; after `foo` changes its `main`, an import of `foo` from a module that is not reloaded still resolves to `../shared/index.js`. The same applies to an entry file of a package that is a link to a file outside it.
- **References to previous exports.** Code that is not reloaded keeps the values it obtained from a previous module. For example, a plugin that is not stale stores the namespace of `await import('./util.mjs')`; after `util.mjs` changes and is evicted, the stored namespace still holds the previous functions. Dynamic imports are not edges of the module graph, so the plugin is not replaced.
- **Caches of libraries and hooks.** HMR clears the caches of Node.js only. For example, a hook that caches `package.json` to decide the format of a file keeps the previous `type` after a package switches between CommonJS and ESM.
- **`module.findPackageJSON()`.** On Node.js 24+, it may report the previous manifest of a file. For example, after a build adds `dist/esm/package.json` with `{ "type": "module" }`, a lookup for a file below `dist/esm` that was looked up before still reports the manifest of the package.
