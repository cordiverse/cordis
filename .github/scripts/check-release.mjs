// Checks the versions of a pull request on its merge commit `HEAD`, whose first parent is the base.
// Environment: PR_RELEASE (`true` for a pull request with the `release` label), PR_BODY.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import semver from 'semver'

const errors = []

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

// the manifest at a commit, or null if it does not exist
function readManifest(path, ref) {
  if (!git('ls-tree', '--name-only', ref, '--', path)) return null
  return JSON.parse(git('show', `${ref}:${path}`))
}

// the manifests of the workspaces tracked in this repository, excluding the root
const workspacePaths = execFileSync('yarn', ['workspaces', 'list', '--json'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .map(line => JSON.parse(line).location)
  .filter(location => location !== '.')
  .map(location => `${location}/package.json`)
const manifestPaths = git('ls-files', '--', ...workspacePaths).split('\n').filter(Boolean)

const base = Object.fromEntries(manifestPaths.map(path => [path, readManifest(path, 'HEAD^1')]))
const head = Object.fromEntries(manifestPaths.map(path => [path, readManifest(path, 'HEAD')]))
const isPublic = manifest => !!manifest && !manifest.private

// a published package is public at the base; a package is published by this pull request
// if it is public at the head and its version at the head is not published yet
const published = manifestPaths.filter((path) => {
  if (!isPublic(head[path])) return false
  return !isPublic(base[path]) || base[path].version !== head[path].version
})

const cordisPath = 'packages/core/package.json'
const isCordisRelease = published.includes(cordisPath)
const tag = `v${head[cordisPath].version}`

if (process.env.PR_RELEASE === 'true') {
  if (!published.length) {
    errors.push('a release must publish at least one package')
  }

  const lockfiles = ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml']

  // a release pull request only bumps versions and updates the lockfile accordingly
  for (const path of git('diff', '--name-only', 'HEAD^1', 'HEAD').split('\n').filter(Boolean)) {
    if (!lockfiles.includes(path) && !manifestPaths.includes(path)) {
      errors.push(`${path} is changed`)
    }
  }

  for (const path of published) {
    const { name, version } = head[path]
    if (isPublic(base[path]) && !semver.gt(version, base[path].version)) {
      errors.push(`the version of ${name} must be greater than ${base[path].version}`)
    }
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`)
    if (response.ok) {
      const { versions } = await response.json()
      if (versions[version]) errors.push(`${name}@${version} is already published`)
    } else if (response.status !== 404) {
      errors.push(`cannot fetch ${name} from npm: HTTP ${response.status}`)
    }
  }

  // the version of `cordis` names a release with a tag and release notes
  if (isCordisRelease) {
    if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
      errors.push(`tag ${tag} already exists`)
    }
    if (!process.env.PR_BODY?.trim()) {
      errors.push('the body must contain the release notes')
    }
  }

  // every internal dependency range is satisfied by the version in this repository
  const versions = Object.fromEntries(Object.values(head).filter(Boolean).map(manifest => [manifest.name, manifest.version]))
  for (const manifest of Object.values(head)) {
    if (!isPublic(manifest)) continue
    for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      if (!versions[name]) continue
      if (!semver.satisfies(versions[name], range, { includePrerelease: true })) {
        errors.push(`${manifest.name} requires ${name}@${range}, but the version is ${versions[name]}`)
      }
    }
  }
} else {
  // only a release changes the versions of the published packages
  for (const path of published) {
    const { name } = head[path]
    errors.push(base[path]
      ? `the version of ${name} is changed without the release label`
      : `${name} is added without the release label and must be private`)
  }
  for (const path of manifestPaths) {
    if (isPublic(base[path]) && head[path] && !isPublic(head[path])) {
      errors.push(`${base[path].name} is made private without the release label`)
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`::error::${error}`)
  process.exit(1)
}

if (published.length) {
  const lines = [
    '## Release',
    '',
    isCordisRelease
      ? `The merge creates the tag \`${tag}\` and the GitHub Release \`Cordis ${head[cordisPath].version}\`.`
      : 'The merge creates no tag and no GitHub Release.',
    '',
    '| Package | Previous version | New version |',
    '| --- | --- | --- |',
    ...published.map((path) => {
      const previous = isPublic(base[path]) ? base[path].version : '-'
      return `| \`${head[path].name}\` | ${previous} | ${head[path].version} |`
    }),
    '',
  ]
  console.log(lines.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'))
} else {
  console.log('no package is published')
}
