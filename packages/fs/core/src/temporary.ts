import { FsError } from './error.ts'
import type { FsProvider } from './index.ts'

// A short, dedicated namespace lets directory watches recognize delayed events,
// including events from another process using the same naming convention.
const pattern = /^\.cordis-[0-9a-f]{12}\.tmp$/i

export function isTemporaryFile(name: string): boolean {
  return pattern.test(name)
}

function temporaryUrl(url: URL, occupied?: URL): URL {
  const leaf = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1)).replace(/[. ]+$/, '').toLowerCase()
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let id = bytes.reduce((value, byte) => value * 256 + byte, 0)
  for (;;) {
    const name = `.cordis-${id.toString(16).padStart(12, '0')}.tmp`
    const candidate = new URL(name, url)
    if (name !== leaf && candidate.href !== occupied?.href) return candidate
    id = (id + 1) % 2 ** 48
  }
}

// Reserve the literal entry before a transfer can consume its source. A known
// final mode is applied by the transfer, so the empty file can start private.
export async function reserveFile(
  dest: URL, provider: FsProvider & Required<Pick<FsProvider, 'write'>>,
  owns: (url: URL) => boolean, mode?: number,
) {
  let url = temporaryUrl(dest)
  let retried = false
  async function create(privateFile: boolean) {
    const options = privateFile ? { exclusive: true, mode: 0o600 } : { exclusive: true }
    for (;;) {
      if (!owns(url)) throw new FsError('NotSupported', dest, `cannot stage a file in the mount of ${dest.href}`)
      try {
        return await provider.write(url, new Blob([]).stream(), options)
      } catch (error) {
        if (retried || !(error instanceof FsError) || error.code !== 'AlreadyExists') throw error
        retried = true
        url = temporaryUrl(dest, url)
      }
    }
  }
  await create(mode !== undefined)
  if (mode !== undefined || !provider.stat || !provider.remove) return { url, mode }

  // A default mode such as 0444 permits creation but prevents reopening.
  // Save it for publication and claim a writable reservation for the transfer.
  const stats = await provider.stat(url, { follow: false }).catch(() => undefined)
  if (stats?.mode === undefined || (stats.mode & 0o200)) return { url, mode }
  try {
    await provider.remove(url, { recursive: false })
  } catch (error) {
    if (error instanceof FsError && error.code === 'NotFound') throw error
    // An ambiguous failure can arrive after removal. Check the entry's identity
    // when available. Otherwise retry cleanup only after an explicit refusal.
    let retained = error instanceof FsError && (error.code === 'Busy' || error.code === 'PermissionDenied')
    if (stats.ino !== undefined) {
      const entry = await provider.stat(url, { follow: false }).catch(() => undefined)
      retained = entry?.ino === stats.ino && entry.dev === stats.dev
    }
    if (retained) await provider.remove(url, { recursive: false }).catch(() => {})
    throw error
  }
  await create(true)
  return { url, mode: stats.mode }
}
