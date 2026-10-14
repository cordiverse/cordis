import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as tar from 'tar'
import { expect, it, onTestFinished } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const bin = resolve(testDir, '../src/bin.ts')
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

// The scaffold reports failures with `process.exit`, so it is exercised the way
// a user runs it: in its own directory, as a child process, against a registry.

/** Environment for the child, with the given keys replaced rather than merged. */
function childEnv(overrides: Record<string, string>) {
  const replaced = Object.keys(overrides).map(key => key.toLowerCase())
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (replaced.includes(key.toLowerCase())) continue
    env[key] = value
  }
  return { ...env, ...overrides }
}

async function runCli(registry: string, args: string[] = [], options: { timeout?: number; yarn?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'cordis-create-'))
  try {
    await writeFile(join(cwd, '.npmrc'), `registry=${registry}\n`)
    // `bin.ts` passes no deadline, so a test that needs one runs its own entry
    let entry = bin
    if (options.timeout || options.yarn) {
      entry = join(cwd, 'entry.mjs')
      await writeFile(entry, [
        // Keep Yarn's cache and extraction directory inside the test directory.
        `import os from 'node:os'`,
        `os.homedir = os.tmpdir = () => process.cwd()`,
        `const { default: scaffold } = await import(${JSON.stringify(pathToFileURL(resolve(testDir, '../src/index.ts')).href)})`,
        // Detect the registry with npm, then exercise Yarn staging without
        // depending on a global Yarn installation on the test machine.
        ...(options.yarn ? [
          `const fetcher = globalThis.fetch`,
          `globalThis.fetch = (...args) => { process.env.npm_config_user_agent = 'yarn/1.22.19'; return fetcher(...args) }`,
        ] : []),
        `scaffold({ name: 'cordis', version: '0.0.0', template: '@cordisjs/boilerplate', timeout: ${options.timeout} })`,
      ].join('\n'))
    }
    // `get-registry` picks its lookup from `npm_config_user_agent`. Pin it to npm
    // so the registry is read from the config above and not from whichever
    // package manager happens to be running the tests.
    const env = childEnv({
      npm_config_registry: registry,
      npm_config_user_agent: 'npm/10.0.0 node/v22.0.0',
      // env-paths uses these instead of homedir on Linux and Windows.
      ...(options.yarn ? {
        XDG_CACHE_HOME: join(cwd, 'cache'),
        APPDATA: join(cwd, 'appdata'),
        LOCALAPPDATA: join(cwd, 'localappdata'),
      } : {}),
    })

    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((done) => {
      execFile(process.execPath, ['--import', tsx, entry, 'myapp', '--yes', ...args], {
        cwd,
        env,
      }, (error, stdout, stderr) => {
        const code = (error as any)?.code
        done({ stdout, stderr, code: typeof code === 'number' ? code : 0 })
      })
    })
    let packageJson: any
    try {
      packageJson = JSON.parse(await readFile(join(cwd, 'myapp', 'package.json'), 'utf8'))
    } catch {}
    const yarnRc = await readFile(join(cwd, 'myapp', '.yarnrc.yml'), 'utf8').catch(() => null)
    return { output: `${stdout}${stderr}`, code, packageJson, yarnRc }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

// Each test overrides only the response relevant to its scenario.
async function startRegistry(routes: Record<string, (res: ServerResponse) => void> = {}) {
  const server = createServer((req, res) => {
    const handler = routes[req.url!]
    if (handler) {
      handler(res)
    } else if (req.url === '/@cordisjs/boilerplate') {
      res.end(JSON.stringify({
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { dist: { tarball: `${url}/pkg.tgz` } } },
      }))
    } else if (req.url === '/@yarnpkg/cli-dist') {
      res.end(JSON.stringify({ 'dist-tags': { latest: '9.9.9' } }))
    } else {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  return url
}

async function archive(files: Record<string, string>) {
  const source = await mkdtemp(join(tmpdir(), 'cordis-template-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const filename = join(source, 'package', name)
      await mkdir(dirname(filename), { recursive: true })
      await writeFile(filename, content)
    }
    const chunks: Buffer[] = []
    await new Promise<void>((done, fail) => {
      tar.c({ gzip: true, cwd: source }, ['package'])
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .on('end', done)
        .on('error', fail)
    })
    return Buffer.concat(chunks)
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}

it('scaffolds the default template to completion', async () => {
  const tarball = await archive({ 'package.json': '{"name":"template"}' })
  const registry = await startRegistry({ '/pkg.tgz': res => res.end(tarball) })
  const { output, code, packageJson } = await runCli(registry)
  expect(code).toBe(0)
  expect(output).toContain('Done.')
  expect(packageJson.name).toBe('myapp')
}, 30000)

it('reports a registry without a scheme', async () => {
  const { output, code } = await runCli('localhost:4873')
  expect(code).toBe(1)
  expect(output).toContain('error invalid npm registry localhost:4873')
}, 30000)

it('reports an unknown dist-tag', async () => {
  const registry = await startRegistry()
  const { output, code } = await runCli(registry, ['--ref', 'nonexistent-tag-xyz'])
  expect(code).toBe(1)
  expect(output).toContain('error no tarball for nonexistent-tag-xyz')
}, 30000)

it('reports a failed tarball request with its url', async () => {
  const registry = await startRegistry()
  const { output, code } = await runCli(registry)
  expect(code).toBe(1)
  expect(output).toContain(`error request failed with status code 404 Not Found from ${registry}/pkg.tgz`)
}, 30000)

it('reports a template without package.json', async () => {
  const tarball = await archive({ 'README.md': '# template' })
  const registry = await startRegistry({ '/pkg.tgz': res => res.end(tarball) })
  const { output, code } = await runCli(registry)
  expect(code).toBe(1)
  expect(output).toContain('error invalid package.json from @cordisjs/boilerplate')
}, 30000)

it('reports invalid registry json', async () => {
  const registry = await startRegistry({ '/@cordisjs/boilerplate': res => res.end('not json') })
  const { output, code } = await runCli(registry)
  expect(code).toBe(1)
  expect(output).toContain(`error invalid registry response from ${registry}/@cordisjs/boilerplate`)
}, 30000)

it('reports an invalid tarball', async () => {
  const registry = await startRegistry({ '/pkg.tgz': res => res.end('not a tarball') })
  const { output, code } = await runCli(registry)
  expect(code).toBe(1)
  expect(output).toContain(`error invalid tarball from ${registry}/pkg.tgz`)
}, 30000)

// A 204 response has no body: stream creation throws before any error listener runs.
it('reports a tarball response without a body', async () => {
  const registry = await startRegistry({ '/pkg.tgz': res => res.writeHead(204).end() })
  const { output, code } = await runCli(registry)
  expect(code).toBe(1)
  expect(output).toContain(`error invalid tarball from ${registry}/pkg.tgz`)
}, 30000)

it('reports a registry that never sends headers', async () => {
  const registry = await startRegistry({ '/@cordisjs/boilerplate': () => {} })
  const { output, code } = await runCli(registry, [], { timeout: 1000 })
  expect(code).toBe(1)
  expect(output).toContain(`error timed out waiting for ${registry}/@cordisjs/boilerplate`)
}, 30000)

// Reading the body can fail after fetch has resolved; that is not invalid JSON.
it('reports a registry body timeout as a download failure', async () => {
  const registry = await startRegistry({ '/@cordisjs/boilerplate': res => res.write('{') })
  const { output, code } = await runCli(registry, [], { timeout: 1000 })
  expect(code).toBe(1)
  expect(output).toContain(`error timed out downloading ${registry}/@cordisjs/boilerplate`)
}, 30000)

// pipe() does not forward source errors to the tar extractor.
it('reports a tarball body timeout', async () => {
  const registry = await startRegistry({ '/pkg.tgz': res => res.write(Buffer.alloc(2000)) })
  const { output, code } = await runCli(registry, [], { timeout: 1000 })
  expect(code).toBe(1)
  expect(output).toContain(`error timed out downloading ${registry}/pkg.tgz`)
}, 30000)

it('distinguishes a dropped download from an invalid archive', async () => {
  const registry = await startRegistry({
    '/pkg.tgz': (res) => {
      res.write(Buffer.alloc(2000))
      setTimeout(() => res.destroy(), 100)
    },
  })
  const { output, code } = await runCli(registry)
  expect(code).toBe(1)
  expect(output).toContain(`error unable to download ${registry}/pkg.tgz`)
}, 30000)

it('fails when automatic yarn setup cannot download its release', async () => {
  const tarball = await archive({ 'package.json': '{"name":"template"}' })
  const registry = await startRegistry({ '/pkg.tgz': res => res.end(tarball) })
  const { output, code, yarnRc } = await runCli(registry, [], { yarn: true })
  expect(code).toBe(1)
  expect(output).toContain('error unable to set up yarn: request failed with status code 404')
  expect(output).not.toContain('Done.')
  expect(yarnRc).toBe(null)
}, 30000)

it('reports a pinned yarn download timeout without changing the rc', async () => {
  const rc = 'yarnPath: .yarn/releases/yarn-9.9.9.cjs\n'
  const tarball = await archive({ 'package.json': '{}', '.yarnrc.yml': rc })
  const registry = await startRegistry({
    '/pkg.tgz': res => res.end(tarball),
    '/@yarnpkg/cli-dist/-/cli-dist-9.9.9.tgz': res => res.write(Buffer.alloc(2000)),
  })
  const { output, code, yarnRc } = await runCli(registry, [], { yarn: true, timeout: 1000 })
  expect(code).toBe(1)
  expect(output).toContain('error unable to set up yarn: timed out')
  expect(output).not.toContain('Done.')
  expect(yarnRc).toBe(rc)
}, 30000)
