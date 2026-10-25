// Probe for `loadcache.spec.ts`: run with `--expose-internals` and print one
// JSON line describing the module map the eviction block manipulates.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { getOrInitializeCascadedLoader } = require('internal/modules/esm/loader')
const cache = getOrInitializeCascadedLoader().loadCache
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cordis-loadcache-')))

try {
  const jsonPath = join(dir, 'data.json')
  const esmPath = join(dir, 'dep.mjs')
  const cjsPath = join(dir, 'dep.cjs')
  writeFileSync(jsonPath, '{"value":"a"}')
  writeFileSync(esmPath, 'export const value = "a"\n')
  writeFileSync(cjsPath, 'module.exports = { value: "a" }\n')

  const jsonUrl = pathToFileURL(jsonPath).href
  const esmUrl = pathToFileURL(esmPath).href
  const cjsUrl = pathToFileURL(cjsPath).href

  await import(jsonUrl, { with: { type: 'json' } })
  await import(esmUrl)
  await import(cjsUrl)

  const jsonEntry = Map.prototype.get.call(cache, jsonUrl)
  const esmEntry = Map.prototype.get.call(cache, esmUrl)
  const cjsEntry = Map.prototype.get.call(cache, cjsUrl)

  cache.delete(esmUrl)
  const afterDelete = Map.prototype.get.call(cache, esmUrl)

  console.log(JSON.stringify({
    node: process.versions.node,
    instanceofMap: cache instanceof Map,
    mapGetWorks: !!esmEntry,
    jsonSlots: jsonEntry ? Object.keys(jsonEntry) : null,
    hasJson: cache.has(jsonUrl),
    afterDeletePresent: !!afterDelete,
    afterDeleteJavascript: afterDelete ? afterDelete.javascript === undefined : null,
    cjsInLoadCache: !!cjsEntry,
    cjsInRequireCache: !!require.cache[cjsPath],
  }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
