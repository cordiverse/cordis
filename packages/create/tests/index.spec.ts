import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { expect, it } from 'vitest'
import { stageYarnBin } from '../src/index.js'

async function createArchive(root: string) {
  const source = join(root, 'source')
  const filename = join(source, 'package', 'bin', 'yarn.js')
  await mkdir(join(source, 'package', 'bin'), { recursive: true })
  await writeFile(filename, 'fresh')
  await utimes(filename, new Date(0), new Date(0))

  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    tar.c({ gzip: true, cwd: source }, ['package/bin/yarn.js'])
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
  return Buffer.concat(chunks)
}

it('replaces stale temporary yarn binaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cordis-stage-yarn-'))
  try {
    const project = join(root, 'project')
    const tempDir = join(root, 'temp')
    const cacheDir = join(root, 'cache')
    await mkdir(project, { recursive: true })
    await mkdir(tempDir, { recursive: true })
    await writeFile(join(project, 'package.json'), '{}')
    await writeFile(join(tempDir, 'yarn.js'), 'stale')

    const archive = await createArchive(root)
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/@yarnpkg/cli-dist')) {
        return new Response(JSON.stringify({ 'dist-tags': { latest: '9.9.9' } }))
      }
      if (url.endsWith('/cli-dist-9.9.9.tgz')) return new Response(archive)
      throw new Error(`unexpected URL: ${url}`)
    }

    await expect(stageYarnBin({
      rootDir: project,
      registry: 'https://registry.example',
      agent: { name: 'yarn', version: '1.22.0' },
      cacheDir,
      tempDir,
      fetcher,
    })).resolves.toBe('9.9.9')

    const target = join(project, '.yarn', 'releases', 'yarn-9.9.9.cjs')
    await expect(readFile(target, 'utf8')).resolves.toBe('fresh')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
