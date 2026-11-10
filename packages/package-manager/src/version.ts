/** Compare two versions of the form `major.minor.patch`, ignoring a prerelease or build suffix. */
export function compareVersions(a: string, b: string) {
  const parts = (version: string) => version.split(/[-+]/)[0].split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let index = 0; index < 3; index++) {
    const diff = (x[index] || 0) - (y[index] || 0)
    if (diff) return diff
  }
  return 0
}

/** Whether a version is in the range `[min, max)`. */
export function isInRange(version: string, [min, max]: readonly [string, string]) {
  return compareVersions(version, min) >= 0 && compareVersions(version, max) < 0
}
