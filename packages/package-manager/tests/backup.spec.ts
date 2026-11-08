import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FileBackup } from '../src/backup.ts'

const temp = join(tmpdir(), `cordis-package-manager-backup-${process.pid}`)
let counter = 0

function createDir() {
  const dir = join(temp, `case-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

afterAll(() => {
  rmSync(temp, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('FileBackup', () => {
  it('restores the mode of a file', async () => {
    const path = join(createDir(), '.npmrc')
    writeFileSync(path, 'secret\n')
    chmodSync(path, 0o600)
    const backup = await FileBackup.create([path])
    rmSync(path)
    writeFileSync(path, 'changed\n', { mode: 0o644 })

    await backup.restore()
    expect(readFileSync(path, 'utf8')).to.equal('secret\n')
    expect(statSync(path).mode & 0o777).to.equal(0o600)
  })

  it('restores a link that has been replaced by a file', async () => {
    const dir = createDir()
    const path = join(dir, '.npmrc')
    writeFileSync(join(dir, 'shared.npmrc'), 'shared\n')
    symlinkSync('shared.npmrc', path)
    const backup = await FileBackup.create([path])
    rmSync(path)
    writeFileSync(path, 'changed\n')
    writeFileSync(join(dir, 'shared.npmrc'), 'also changed\n')

    await backup.restore()
    expect(lstatSync(path).isSymbolicLink()).to.equal(true)
    expect(readlinkSync(path)).to.equal('shared.npmrc')
    expect(readFileSync(join(dir, 'shared.npmrc'), 'utf8')).to.equal('shared\n')
  })
})
