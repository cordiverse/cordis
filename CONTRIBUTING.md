# Contributing to Cordis

Thank you for helping improve Cordis. Bug fixes, tests, documentation, and
focused feature proposals are welcome.

## Before you start

- Search the existing issues and pull requests to avoid duplicating work.
- For behavior changes or larger features, open an issue first and agree on
  the intended API and scope with the maintainers.
- Keep each pull request focused on one problem.

## Development setup

Cordis is a Yarn workspace. The versions used by CI are Node.js 24 and 26, and
the repository pins its Yarn release in `package.json`.

```sh
git clone https://github.com/<your-account>/cordis.git
cd cordis
corepack enable
yarn --no-immutable
```

Add the main repository as an upstream remote if you cloned a fork:

```sh
git remote add upstream https://github.com/cordiverse/cordis.git
```

Create a topic branch from the latest `main` before making changes:

```sh
git fetch upstream
git switch -c fix/short-description upstream/main
```

## Repository layout

- `packages/core`: the `cordis` runtime and its tests
- `packages/include`, `packages/loader`, `packages/hmr`, and
  `packages/group`: official plugins
- `packages/timer`, `packages/logger-console`, and `packages/utils`: supporting
  packages
- `packages/create`: project creation tooling

Place tests in the affected package's `tests` directory and follow the existing
`*.spec.ts` naming convention.

## Validation

Run the checks relevant to your change before opening a pull request:

```sh
yarn lint
yarn build
yarn test
```

The full test command supports a Vitest name or path filter for faster local
iteration. For example:

```sh
yarn test cordis/events
yarn test include/patch
```

Run the full suite before submission even when a focused test passes. CI runs
linting and builds on Node.js 24, and tests on Node.js 24 and 26.

## Style

- Use TypeScript and match the surrounding code's patterns.
- Use two-space indentation, LF line endings, UTF-8, and a final newline, as
  configured in `.editorconfig`.
- Let the shared ESLint configuration enforce formatting and code-quality
  rules; avoid unrelated formatting changes.
- Add regression coverage for bug fixes and tests for new behavior.
- Update package documentation when a public API or user-facing behavior
  changes.

## Pull requests

In the pull request description:

- explain the problem and its observable impact;
- describe the chosen fix and any compatibility considerations;
- link the related issue with `Fixes #<number>` when appropriate;
- list the exact validation commands you ran;
- call out tests that could not be run and explain why.

Keep generated files, dependency changes, and refactors out of the pull request
unless they are required for the fix. By contributing, you agree that your
changes are provided under the repository's [MIT License](LICENSE).
