# Contributing to Cordis

Thanks for your interest in contributing. Bug fixes, tests, documentation and
focused feature proposals are all welcome. If you are not sure whether a change
is wanted, open an issue first to discuss the API and scope.

## Repository layout

Cordis is a Yarn workspace monorepo, driven by [yakumo](https://github.com/yakumojs/yakumo). Packages live under `packages/`:

- `core` — the framework runtime (`cordis`)
- `loader` — plugin loading and config reloading
- `hmr` — hot module reloading support
- `include` — config file inclusion
- `group` — group model utilities
- `logger-console`, `timer`, `utils` — supporting packages
- `create` — scaffolding for new projects

Tests live in the affected package's `tests/` directory and follow the
`*.spec.ts` naming convention.

## Development setup

The repository pins its Yarn release in `package.json`; CI enables it through
Corepack.

```sh
git clone https://github.com/<your-account>/cordis.git
cd cordis
corepack enable
yarn --no-immutable
```

Create a topic branch from the latest upstream `main`:

```sh
git remote add upstream https://github.com/cordiverse/cordis.git
git fetch upstream
git switch -c fix/short-description upstream/main
```

## Common commands

Run everything from the repository root:

| Command        | Description                                        |
| -------------- | -------------------------------------------------- |
| `yarn lint`    | Lint the codebase with ESLint                      |
| `yarn build`   | Bundle with esbuild, then type-check with `tsc`    |
| `yarn test`    | Run the test suite with Vitest                     |
| `yarn test:json` / `test:text` / `test:html` | Same suite with a JSON/text/HTML coverage report |

To run the tests of one package only, pass the workspace name (and optionally a
file) as a positional filter:

```sh
yarn test core
yarn test core/events
yarn test include/patch
```

Run the full suite before opening a pull request, even when a focused run
passes.

## Commit messages

The history follows [Conventional Commits](https://www.conventionalcommits.org/):
a type prefix (`feat`, `fix`, `chore`, `docs`, `test`, `ci`, ...), optionally
scoped to the package, with the related issue in parentheses when applicable.

```text
feat(hmr): support hmr.watch() (#128)
fix(include): reconcile file and runtime edits through a journal (#121)
chore: bump versions
```

## Pull requests

- Keep each pull request focused on one problem, with regression coverage for
  bug fixes and tests for new behavior.
- In the description, explain the problem and the chosen fix, link the issue
  (`Fixes #123`), and list the validation commands you ran.
- Do not include generated files, unrelated formatting churn, or dependency
  changes unless they are required for the fix.
- The project uses two-space indentation, LF line endings, UTF-8 and a final
  newline, as configured in `.editorconfig`.

## CI

The [build workflow](.github/workflows/build.yml) runs on every push:
`yarn lint` and `yarn build` on Node.js 26, and `yarn test:json` on Node.js 24
and 26 across Linux, Windows and macOS. All jobs must pass before a pull
request is merged.

By contributing, you agree that your changes are provided under the repository's
[MIT License](LICENSE).
