import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll } from 'vitest'

/** Node 24.16+ and 26.1+ pass the ESM realpath cache to `fs.realpathSync`. */
export const realpathESM = (() => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 26 || major === 26 && minor >= 1 || major === 24 && minor >= 16
})()

interface RunOptions {
  /** code that precedes the import of the runtime, such as the registration of hooks */
  preamble?: string
  /** the bundle of the runtime to import */
  library?: string
  activate?: boolean
}

/** A temporary directory for the tests of a file, with an esbuild bundle of the HMR runtime in it. */
export function useFixtures(name: string) {
  const fixtures = {
    /** a real path, as resolved paths are, e.g. /private/var on macOS */
    dir: '',
    bundle: '',

    fixture(path: string, content: string) {
      path = join(fixtures.dir, path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return path
    },

    /**
     * Run `body` as an ES module in a child process, for a case that needs a
     * thread where nothing is installed or captured yet, or that changes the
     * state of the process, such as its hooks. `activate`, `loader`, `modules`,
     * `importModule`, `invalidateResolution` and `getResolutionSupport` are in
     * scope, and the replacements are activated unless `activate` is false.
     * The result of `body` is printed and returned.
     */
    runESM(name: string, body: string, options: RunOptions = {}) {
      const { preamble = '', library = fixtures.bundle, activate = true } = options
      const script = fixtures.fixture(`${name}.mjs`, `
        import { rmSync } from 'node:fs'
        ${preamble}
        import { activate, getResolutionSupport, invalidateResolution, ModuleCaches, ModuleLoader } from ${JSON.stringify(pathToFileURL(library).href)}
        const loader = ModuleLoader.fromInternal()
        const modules = new ModuleCaches(loader)
        const importModule = (specifier, parentURL) => loader.import(specifier, parentURL, {})
        ${activate ? 'activate()' : ''}
        console.log(JSON.stringify(await (async () => { ${body} })()))
      `)
      const output = execFileSync(process.execPath, ['--expose-internals', script], {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '' },
      })
      return JSON.parse(output)
    },
  }

  beforeAll(async () => {
    fixtures.dir = realpathSync(mkdtempSync(join(tmpdir(), `hmr-runtime-${name}-`)))
    fixtures.bundle = join(fixtures.dir, 'runtime.mjs')
    await build({
      entryPoints: [resolve(fileURLToPath(import.meta.url), '../../src/runtime/index.ts')],
      outfile: fixtures.bundle,
      bundle: true,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    })
  })

  afterAll(() => {
    rmSync(fixtures.dir, { recursive: true, force: true })
  })

  return fixtures
}
