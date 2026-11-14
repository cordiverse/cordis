import { InstallState } from './state.ts'

/**
 * How long a second read waits, so that a momentary lock on the folder has gone: the longest
 * interval the existing rename loop ever waits (`RENAME_BACKOFF * RENAME_RETRIES` in `loader`),
 * used here as the only one, because a second read costs a whole walk.
 *
 * One attempt, not the eleven that loop uses: a rename costs a syscall, while a read walks the
 * whole tree, so eleven attempts would repeat a whole-tree read eleven times before reporting a
 * failure that is already decided -- and a lock that lasts long enough to survive ten of those
 * has already stopped being momentary.
 */
const REREAD_DELAY = 200

/**
 * Read the state again after a momentary lock, since reading it is idempotent and a lock on the
 * folder usually lifts.
 *
 * A wall that is still there fails the call, and because this read is taken inside `_install`'s
 * `try`, the recovery path runs -- unlike the read taken before the install, which is outside it
 * and fails before anything has changed. That difference is the reason a persistent wall here is
 * costly: the install has already happened, and the recovery restores the manifest and asks the
 * agent to reinstall from the restored lockfile.
 *
 * Reading the lockfile instead would not work: `diffState` also reports a package whose
 * `realpath` moved, and an ancestor link that was replaced moves it without touching the
 * lockfile. Answering here would mean re-deriving that comparison, which is `diffState`'s.
 */
export async function reread(readState: () => Promise<InstallState>): Promise<InstallState> {
  try {
    return await readState()
  } catch (error) {
    // Only the codes a lock produces are worth the second attempt. Everything else -- a path that
    // is not there, a disk that is full -- answers the same however long we wait, so waiting only
    // delays a failure that is already decided.
    if (!isTransient(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, REREAD_DELAY))
    return readState()
  }
}

/**
 * Whether a read failed for a reason that a moment may fix. The same three codes as the
 * `isTransientRenameError` in `loader` and `include`, which is the retry policy this package
 * already lives with; anything else answers the same on every attempt.
 */
function isTransient(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}
