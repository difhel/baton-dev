# Baton

Baton is a CLI for managing private agent instructions per project.

It keeps your personal specs in a private GitHub repository, clones them into `~/.baton`, and exposes them inside working repositories through a `.baton-specs` symlink. Baton also injects a temporary reminder block into `AGENTS.md` so local coding agents know to read `.baton-specs/README.md`.

## Requirements
- For users:
  - Node.js 18+
  - `git`
  - GitHub CLI (`gh`) authenticated with the account that should own `baton-specs`
- For development and release builds:
  - [Bun](https://bun.sh)

## Install
Install from npm:

```bash
npm install -g baton-dev
```

The installed command is:

```bash
baton
```

To work on the project itself:

```bash
bun install
```

Run the CLI during development with:

```bash
bun run index.ts <command>
```

Standalone binaries can also be distributed through GitHub releases.

## Quick start
1. Bootstrap the private specs repo:

   ```bash
   baton sync --create
   ```

2. Register a project:

   ```bash
   baton add my-project ~/code/my-project
   ```

3. Touch a working repository:

   ```bash
   cd ~/code/my-project
   baton touch
   ```

4. Edit your private specs in `.baton-specs/`.

5. Sync changes back to GitHub:

   ```bash
   baton sync
   ```

## Commands
### `baton sync [--create]`
Bootstraps or synchronizes the private `baton-specs` repository.

- `--create` ensures `https://github.com/<gh-user>/baton-specs` exists and clones it into `~/.baton`
- commits pending changes in `~/.baton` when needed
- pulls and pushes the current branch

### `baton add <id> <path-or-url>`
Registers a project inside `~/.baton`.

- if a path is provided, Baton reads the repository’s `origin` URL
- if a URL is provided, it must be an exact GitHub repository URL
- Baton creates `~/.baton/<id>/baton.json` and `~/.baton/<id>/README.md`

### `baton touch [id]`
Activates specs inside the current git repository.

- creates `.baton-specs` as a symlink to `~/.baton/<id>`
- adds `.baton-specs` to `.git/info/exclude`
- ensures `AGENTS.md` contains exactly one Baton block
- installs `pre-commit` and `post-commit` hooks so the Baton block is not committed

If `id` is omitted, Baton matches the current repo by normalized `origin` URL.

### `baton run <script>`
Runs a script from the current project’s `baton.json`.

- resolves the project from the touched-repo mapping first
- falls back to matching the repository `origin` URL if the repo has not been touched
- runs in the current working directory

### `baton ls`
Lists registered projects and any touched repositories known to local Baton state.

## `AGENTS.md` behavior
Touched repositories get this temporary block:

```md
<!-- baton:start -->
You must read `.baton-specs/README.md`
<!-- baton:end -->
```

Baton is intentionally strict here:
- it preserves non-Baton `AGENTS.md` content
- it rejects malformed or duplicate Baton blocks instead of silently rewriting them
- the pre-commit hook strips the Baton block from the staged `AGENTS.md` only
- the post-commit hook restores the Baton block in the worktree

## Project layout
Example private specs repo:

```text
~/.baton/
  my-project/
    baton.json
    README.md
    CODESTYLE.md
```

Working repository after `baton touch`:

```text
repo/
  .baton-specs -> ~/.baton/my-project
  AGENTS.md
```

## Testing
Run the test suite with:

```bash
bun test
```

Run type checking with:

```bash
bunx tsc --noEmit
```

Build the npm CLI bundle with:

```bash
npm run build
```

Build a standalone executable for the current platform with:

```bash
npm run build-executable
```

## Release
Recommended release flow:

```bash
npm run release:check
```

That runs type-checking, tests, the production build, and `npm pack --dry-run`.

To publish to npm manually:

```bash
npm run release:npm
```

To create the release commit and git tag manually:

```bash
npm run release:git
```

To do both in sequence:

```bash
npm run release
```

Notes:
- `release:git` pushes to the current checked-out branch, not a hardcoded branch name.
- The npm package name is `baton-dev`, while the installed binary name is `baton`.
- `npm publish` requires that the `baton-dev` package name is available or that you have permission to publish it.
- GitHub Actions do not publish to npm.
- GitHub Actions only build release binaries and attach them to GitHub releases for pushed version tags.

## Notes
- Baton stores canonical project specs in `~/.baton`; working repositories only get symlinks.
- Baton local state lives in `~/.baton/.baton-local/` and is excluded from git.
- For the full behavior contract, see [SPEC.md](./SPEC.md).
