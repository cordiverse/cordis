import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as tar from 'tar'
import { describe, expect, it } from 'vitest'
import { stageYarnBin } from '../src'

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

async function runCli(registry: string, args: string[] = [], timeout?: number) {
  const cwd = await mkdtemp(join(tmpdir(), 'cordis-create-'))
  try {
    await writeFile(join(cwd, '.npmrc'), `registry=${registry}\n`)
    // `bin.ts` passes no deadline, so a test that needs one runs its own entry
    let entry = bin
    if (timeout) {
      entry = join(cwd, 'entry.mjs')
      await writeFile(entry, [
        `import scaffold from ${JSON.stringify(pathToFileURL(resolve(testDir, '../src/index.ts')).href)}`,
        `scaffold({ name: 'cordis', version: '0.0.0', template: '@cordisjs/boilerplate', timeout: ${timeout} })`,
      ].join('\n'))
    }
    // `get-registry` picks its lookup from `npm_config_user_agent`. Pin it to npm
    // so the registry is read from the config above and not from whichever
    // package manager happens to be running the tests.
    const env = childEnv({
      npm_config_registry: registry,
      npm_config_user_agent: 'npm/10.0.0 node/v22.0.0',
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
    return { output: `${stdout}${stderr}`, code, packageJson }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

/** Serves a dist-tag document for the default template, and optionally its tarball. */
async function startRegistry(buildMeta: (url: string) => unknown, tarball?: Buffer) {
  const server = createServer((req, res) => {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    if (req.url === '/@cordisjs/boilerplate') {
      const body = buildMeta(url)
      const text = typeof body === 'string'
      res.writeHead(200, { 'content-type': text ? 'text/plain' : 'application/json' })
      res.end(text ? body as string : JSON.stringify(body))
    } else if (tarball && req.url === '/pkg.tgz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(tarball)
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

function meta(tarball: string) {
  return { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball } } } }
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

it('reports a registry that is not a url', async () => {
  const { output, code } = await runCli('my-company-mirror')
  expect(output).toContain('error invalid url my-company-mirror/@cordisjs/boilerplate')
  expect(code).toBe(1)
}, 30000)

it('reports a dist-tag that resolves to nothing', async () => {
  const registry = await startRegistry(() => ({ 'dist-tags': {}, versions: {} }))
  try {
    const { output, code } = await runCli(registry.url, ['--ref', 'nonexistent-tag-xyz'])
    expect(output).toContain('error no tarball for nonexistent-tag-xyz')
    expect(code).toBe(1)
  } finally {
    await registry.close()
  }
}, 30000)

it('reports a failed request with its url', async () => {
  const registry = await startRegistry(url => meta(`${url}/missing.tgz`))
  try {
    const { output, code } = await runCli(registry.url)
    expect(output).toContain('error request failed with status code 404 Not Found from')
    expect(output).toContain('/missing.tgz')
    expect(code).toBe(1)
  } finally {
    await registry.close()
  }
}, 30000)

it('reports a template without a usable package.json', async () => {
  const tarball = await archive({ 'README.md': '# template\n' })
  const registry = await startRegistry(url => meta(`${url}/pkg.tgz`), tarball)
  try {
    const { output, code } = await runCli(registry.url)
    expect(output).toContain('error invalid package.json from @cordisjs/boilerplate')
    expect(code).toBe(1)
  } finally {
    await registry.close()
  }
}, 30000)

it('reports a dist-tag whose version is missing', async () => {
  const registry = await startRegistry(() => ({ 'dist-tags': { latest: '1.0.0' }, versions: {} }))
  try {
    const { output, code } = await runCli(registry.url)
    expect(output).toContain('error no tarball for latest')
    expect(code).toBe(1)
  } finally {
    await registry.close()
  }
}, 30000)

it('reports a meta without dist-tags', async () => {
  const registry = await startRegistry(() => ({}))
  try {
    const { output, code } = await runCli(registry.url)
    expect(output).toContain('error no tarball for latest')
    expect(code).toBe(1)
  } finally {
    await registry.close()
  }
}, 30000)

it('reports a meta that is not json', async () => {
  const registry = await startRegistry(() => 'not json')
  try {
    const { output, code } = await runCli(registry.url)
    expect(output).toContain(`error invalid registry response from ${registry.url}/@cordisjs/boilerplate`)
    expect(code).toBe(1)
  } finally {
    await registry.close()
  }
}, 30000)

it('reports a tarball that is not a tarball', async () => {
  const registry = await startRegistry(url => meta(`${url}/pkg.tgz`), Buffer.from('not a tarball'))
  try {
    const { output, code } = await runCli(registry.url)
    expect(output).toContain('error invalid tarball from')
    expect(output).toContain('/pkg.tgz')
    expect(code).toBe(1)
  } finally {
    await registry.close()
  }
}, 30000)

it('reports an unreachable registry', async () => {
  const { output, code } = await runCli('http://127.0.0.1:9')
  expect(output).toContain('error unable to reach http://127.0.0.1:9/@cordisjs/boilerplate')
  expect(code).toBe(1)
}, 30000)

it('scaffolds the default template to completion', async () => {
  const tarball = await archive({
    'package.json': `${JSON.stringify({ name: 'placeholder', version: '1.0.0' }, null, 2)}\n`,
  })
  const registry = await startRegistry(url => meta(`${url}/pkg.tgz`), tarball)
  try {
    const { output, code, packageJson } = await runCli(registry.url)
    expect(output).toContain('Done.')
    expect(code).toBe(0)
    expect(packageJson.name).toBe('myapp')
  } finally {
    await registry.close()
  }
}, 30000)

// A registry that accepts the request and never answers cannot report itself:
// without a deadline the CLI waits forever.
it('reports a registry that never answers', async () => {
  const server = createServer(() => { /* the request is accepted and left open */ })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
  const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    // The deadline is injectable, so the test does not wait for the default deadline.
    const { output, code } = await runCli(registry, [], 200)
    expect(output).toContain(`error timed out waiting for ${registry}`)
    expect(code).toBe(1)
  } finally {
    server.close()
  }
}, 30000)

/** Serves the default template's meta, and a tarball body handled by `sendTarball`. */
async function startTarballServer(sendTarball: (res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    if (req.url === '/@cordisjs/boilerplate') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(meta(`${url}/pkg.tgz`)))
    } else if (req.url === '/pkg.tgz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      sendTarball(res)
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()))
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

// A registry that sends headers instantly but trickles the body is cut off
// mid-stream by the deadline: the source error must reach the report, not escape.
it('reports a tarball whose download times out', async () => {
  const { server, url } = await startTarballServer((res) => {
    let sent = 0
    const timer = setInterval(() => {
      res.write(Buffer.alloc(2000))
      if (++sent > 30) {
        clearInterval(timer)
        res.end()
      }
    }, 100)
  })
  try {
    // The deadline is injected so the body is cut mid-stream quickly.
    const { output, code } = await runCli(url, [], 400)
    expect(output).toContain(`error timed out downloading ${url}/pkg.tgz`)
    expect(output).not.toContain('Unhandled')
    expect(code).toBe(1)
  } finally {
    server.close()
  }
}, 30000)

it('reports a tarball whose connection drops', async () => {
  const { server, url } = await startTarballServer((res) => {
    res.write(Buffer.alloc(2000))
    setTimeout(() => res.socket!.destroy(), 100)
  })
  try {
    const { output, code } = await runCli(url)
    expect(output).toContain(`error unable to download ${url}/pkg.tgz`)
    expect(code).toBe(1)
  } finally {
    server.close()
  }
}, 30000)

describe('stageYarnBin', () => {
  async function stage(tarball: () => Response) {
    const root = await mkdtemp(join(tmpdir(), 'cordis-stage-'))
    const rootDir = join(root, 'project')
    await mkdir(rootDir)
    await writeFile(join(rootDir, 'package.json'), '{}')
    const fetcher = (async (url: string) => {
      if (url.endsWith('/@yarnpkg/cli-dist')) {
        return new Response(JSON.stringify({ 'dist-tags': { latest: '9.9.9' } }))
      }
      return tarball()
    }) as typeof fetch
    const task = stageYarnBin({
      rootDir,
      registry: 'https://registry.invalid',
      agent: { name: 'yarn', version: '1.22.19' },
      cacheDir: join(root, 'cache'),
      tempDir: join(root, 'temp'),
      fetcher,
    })
    return { task, rc: () => readFile(join(rootDir, '.yarnrc.yml'), 'utf8').catch(() => null), root }
  }

  it('skips a yarn release whose tarball is missing', async () => {
    const { task, rc, root } = await stage(() => new Response('not found', { status: 404 }))
    try {
      expect(await task).toBe(undefined)
      expect(await rc()).toBe(null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // The scaffold catches this and carries on; an error escaping as an event
  // would crash the process instead.
  it('rejects when the yarn download is cut off', async () => {
    const { task, rc, root } = await stage(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2000))
        controller.error(new Error('connection dropped'))
      },
    })))
    try {
      await expect(task).rejects.toThrow('connection dropped')
      expect(await rc()).toBe(null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
