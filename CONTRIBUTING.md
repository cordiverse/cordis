# Contributing to Cordis

Thanks for your interest in contributing! This document covers how to get started
with development, and what is expected when you open a pull request.

## Repository overview

Cordis is a TypeScript monorepo managed with [Yarn 4](https://yarnpkg.com/) workspaces
and [yakumo](https://github.com/yakumojs/yakumo). It contains the following packages
under `packages/`:

- `core` — the framework runtime
- `create` — scaffolding for new projects
- `group` — group model utilities
- `hmr` — hot module reloading support
- `include` — config file inclusion
- `loader` — plugin loading
- `logger-console` — console log formatting
- `timer` — timer model utilities
- `utils` — shared utilities

There are also external workspaces under `external/`.

## Prerequisites

- [Node.js](https://nodejs.org/) 24 or newer (CI runs on Node 24 and 26)
- [Corepack](https://github.com/nodejs/corepack) enabled, so that the pinned Yarn
  version in `package.json` is used automatically
- Git

## Setting up the development environment

1. Fork the repository on GitHub, then clone your fork:

   ```sh
   git clone git@github.com:<your-username>/cordis.git
   cd cordis
   git remote add upstream git@github.com:cordiverse/cordis.git
   ```

2. Install dependencies:

   ```sh
   corepack enable
   yarn
   ```

## Common commands

Run everything from the repository root:

| Command       | Description                                              |
| ------------- | -------------------------------------------------------- |
| `yarn lint`      | Lint the codebase with ESLint                          |
| `yarn build`     | Build all packages (esbuild, then type check with tsc) |
| `yarn test`      | Run the test suite with Vitest                         |
| `yarn test:text` | Run tests with a text coverage report                  |
| `yarn test:html` | Run tests with an HTML coverage report                 |

To run commands for a single package, prefix the command with
`yarn yakumo` and append the workspace name, for example:

```sh
yarn yakumo vitest --import tsx core
```

## Making changes

1. Base your work on the latest `main`:

   ```sh
   git fetch upstream
   git checkout -b <branch-name> upstream/main
   ```

2. Make your changes. Keep them focused: one logical change per pull request.
3. Add tests for any behavior change. Tests live in `packages/<package>/tests/`
   and are written with Vitest.
4. Run the checks locally before pushing:

   ```sh
   yarn lint
   yarn build
   yarn test
   ```

5. Commit your changes and push to your fork:

   ```sh
   git push -u origin <branch-name>
   ```

6. Open a pull request against `cordiverse/cordis:main`. If your change addresses
   an issue, reference it in the PR description (e.g. "Closes #123").

## Commit message conventions

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

- Use a type prefix: `feat`, `fix`, `perf`, `refactor`, `chore`, `docs`, `test`, etc.
- Scope the message to the package you changed, e.g. `fix(core): ...`,
  `feat(loader): ...`, `chore: ...` for repository-wide changes.
- Keep the subject line under 72 characters, starting with a lowercase letter.

Examples from the repository history:

```text
fix(core): track direct service callers
feat(loader): use internal loader without `--expose-internals`
perf(core): avoid binding callbacks in event dispatch
chore: bump versions
```

## Code style

- The project uses the `@cordisjs/eslint-config` preset; run `yarn lint` before
  pushing.
- TypeScript is compiled in strict mode; type errors fail the CI build.
- Do not introduce new runtime dependencies without discussing them first.

## CI

The [build workflow](.github/workflows/build.yml) runs three jobs on every pull
request:

- `lint` — ESLint
- `build` — esbuild bundling and `tsc` type checking
- `test` — the full Vitest suite on Node 24 and 26

All of them must pass before a pull request can be merged. You can reproduce them
locally with `yarn lint`, `yarn build`, and `yarn test`.

## Questions

If you are not sure whether a change is wanted, open an issue first to discuss it.
The issue tracker is also the right place to report bugs and request features.
