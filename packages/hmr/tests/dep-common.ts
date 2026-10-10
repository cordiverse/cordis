// A dependency shared by plugin-dep.ts and plugin-dep-sibling.ts that no test
// ever modifies. It sits in plugin-dep's dependency tree, so it is evicted from
// the module cache when dep.ts changes; that alone must not make the sibling
// stale.
export const commonValue = 'common'
