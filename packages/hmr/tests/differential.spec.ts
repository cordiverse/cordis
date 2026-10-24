import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { beforeAll, describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
// testDir is packages/hmr/tests, so the repository root is three levels up
const root = resolve(testDir, '../../..')
const script = resolve(testDir, '__probe__', 'differential.mjs')

let bundle: string

// The workspace is bundled once: the modules have to sit in Node's own module
// cache, which a translating loader bypasses. The bundle stays inside the
// repository so that the external packages resolve from its `node_modules`.
beforeAll(async () => {
  bundle = resolve(testDir, '__probe__', 'workspace.bundle.mjs')
  await build({
    stdin: {
      contents: [
        "export { Context } from 'cordis'",
        "export { default as Loader } from '@cordisjs/plugin-loader'",
        `export { default as Hmr } from ${JSON.stringify(resolve(root, 'packages/hmr/src/index.ts'))}`,
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    external: ['cosmokit', 'schemastery', 'chokidar', 'picomatch', '@babel/code-frame'],
    alias: {
      cordis: resolve(root, 'packages/core/src/index.ts'),
      '@cordisjs/plugin-loader': resolve(root, 'packages/loader/src/index.ts'),
    },
    logLevel: 'silent',
  })
}, 180000)

interface Diff {
  observable: Record<string, unknown>
  report: Record<string, unknown>
}

function run(scenario: string, mode: 'hmr' | 'cold'): Diff {
  // the same flag the test runner passes: without it (and without the
  // optional `node-addon-require-builtin`) the engine has no cache to evict
  const output = execFileSync(process.execPath, ['--expose-internals', script, scenario, mode, bundle], {
    encoding: 'utf8',
    timeout: 120000,
  })
  const line = output.split('\n').find(item => item.startsWith('DIFF '))
  if (!line) throw new Error(`no DIFF line from ${scenario}/${mode}: ${output.slice(-600)}`)
  return JSON.parse(line.slice(5))
}

// The main correctness judge: whatever an HMR path reaches, a cold start from
// the same files must reach too. The `type` scenario is covered separately —
// its load hook is not called under a test runner, so it runs in its own
// plain-process test (`type-flip.spec.ts`).
describe('differential: an HMR path reaches what a cold start reaches', () => {
  // Every change kind reaches a state a cold start can be compared against. A
  // host change is compared in a different form — the engine reports that a
  // restart is required, and the cold start shows the restart is what gives the
  // right state — but it is compared.
  for (const scenario of ['entry', 'shared', 'roots', 'fix', 'cjs', 'json', 'add', 'main', 'churn', 'middle', 'type', 'delete', 'multi', 'host']) {
    it(scenario, () => {
      const hmr = run(scenario, 'hmr')
      const cold = run(scenario, 'cold')
      if (scenario === 'host') {
        expect(String(hmr.report.restart)).to.contain('host module changed')
        expect(hmr.observable.value).to.equal('h1')
        expect(cold.report.restart).to.equal(null)
        expect(cold.observable.value).to.equal('h2')
        return
      }
      expect(hmr.observable).to.deep.equal(cold.observable)
      // and the HMR side really did reload, rather than trivially agreeing
      const replaced = (hmr.report.replaced ?? hmr.report.replacedAfterFix) as number
      // `churn` is the control: nothing changed, so nothing may be replaced
      if (scenario === 'churn') expect(replaced).to.equal(0)
      else expect(replaced).to.be.greaterThan(0)
      // `multi` also pins the split itself: one unit aborted, the other committed
      if (scenario === 'multi') {
        expect(hmr.report.aborted).to.equal(1)
        expect(hmr.report.replacedFirst).to.equal(1)
      }
    }, 240000)
  }
})
