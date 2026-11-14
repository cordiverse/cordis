// Environment: PR_TITLE, PR_HEAD_REF, PR_BODY.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import semver from 'semver'

const errors = []

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function readManifest(path, ref) {
  const content = ref ? git('show', `${ref}:${path}`) : readFileSync(path, 'utf8')
  return JSON.parse(content)
}

// the manifests of the workspaces, excluding the root
const manifestPaths = execFileSync('yarn', ['workspaces', 'list', '--json'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .map(line => JSON.parse(line).location)
  .filter(location => location !== '.')
  .map(location => `${location}/package.json`)

const version = readManifest('packages/core/package.json').version
const tag = `v${version}`

// the version of `cordis` names the release
const previous = readManifest('packages/core/package.json', 'HEAD^1').version
if (version === previous) {
  errors.push(`the version of cordis is still ${version}`)
}
if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
  errors.push(`tag ${tag} already exists`)
}

if (process.env.PR_TITLE !== `chore: release ${tag}`) {
  errors.push(`the title must be "chore: release ${tag}"`)
}
if (process.env.PR_HEAD_REF !== `release/${tag}`) {
  errors.push(`the head branch must be "release/${tag}"`)
}
if (!process.env.PR_BODY?.trim()) {
  errors.push('the body must contain the release notes')
}

const lockfiles = ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml']

// a release pull request only bumps versions and updates the lockfile accordingly
for (const path of git('diff', '--name-only', 'HEAD^1', 'HEAD').split('\n')) {
  if (!lockfiles.includes(path) && !manifestPaths.includes(path)) {
    errors.push(`${path} is changed`)
  }
}

// every internal dependency range is satisfied by the version in this repository
const manifests = manifestPaths.map(path => readManifest(path))
const versions = Object.fromEntries(manifests.map(manifest => [manifest.name, manifest.version]))
for (const manifest of manifests) {
  if (manifest.private) continue
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (!versions[name]) continue
    if (!semver.satisfies(versions[name], range, { includePrerelease: true })) {
      errors.push(`${manifest.name} requires ${name}@${range}, but the version is ${versions[name]}`)
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`::error::${error}`)
  process.exit(1)
}
console.log(`release ${tag} is ready`)
