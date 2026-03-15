Baton is a CLI for managing private, per-project agent instructions outside the repository you are working in.

The project is distributed as a normal npm package for Node users. Bun is used for local development, testing, bundling, and optional standalone executable builds.

Each project's specs live in a private GitHub repository named `baton-specs`, cloned locally into `~/.baton`. When you touch a working repository, Baton adds a `.baton-specs` symlink that points at the matching project folder inside `~/.baton`, so local agents can read your private instructions without committing them into the shared repository.

## Goals
- Keep personal agent instructions out of team repositories.
- Reuse the same specs across multiple clones or worktrees of the same project.
- Make agent instructions visible to local coding agents through a consistent `.baton-specs/README.md` entrypoint.
- Prevent Baton’s temporary `AGENTS.md` reminder block from being committed.

## Initial setup
1. Install Baton.
2. Run `baton sync --create`.

`baton sync --create` uses the currently authenticated `gh` user and ensures that a private GitHub repository exists at:

```text
https://github.com/<gh-user>/baton-specs
```

If the repository does not exist, Baton creates it. Baton then clones it into `~/.baton`.

## Project registration
Register a project with:

```bash
baton add <id> <path-or-url>
```

Rules:
- `id` is the stable local identifier for the project.
- If `<path-or-url>` is a filesystem path, it must point to a git repository with an `origin` remote.
- If `<path-or-url>` is a URL, it must be an exact GitHub repository URL in `owner/repo` form, with optional `.git` or trailing slash.
- Baton normalizes the GitHub URL and stores it in `baton.json`.
- Baton creates a project folder at `~/.baton/<id>`.
- Baton creates stub `baton.json` and `README.md` if they do not already exist.

Example `baton.json`:

```json
{
  "id": "pet-project",
  "githubUrl": "https://github.com/user/my-project",
  "scripts": {
    "up": "npm ci && cp ~/projects/my-project/.env .env"
  }
}
```

Requirements:
- `baton.json` is required.
- `README.md` is required.
- Both files are stored inside the private `baton-specs` repository.

## Touching a repository
Activate specs inside a working repository with:

```bash
baton touch [id]
```

Behavior:
- Baton operates on the current git repository root.
- If `id` is provided, Baton uses it directly.
- If `id` is omitted, Baton reads the current repository’s `origin` URL and matches it against registered projects by normalized GitHub URL.
- Baton creates or refreshes `.baton-specs` as a symlink to `~/.baton/<id>`.
- Baton adds `.baton-specs` to `.git/info/exclude`.
- Baton records the touched repository in local Baton state.

## `AGENTS.md` integration
When a repository is touched, Baton ensures that `AGENTS.md` contains exactly one Baton block:

```md
<!-- baton:start -->
You must read `.baton-specs/README.md`
<!-- baton:end -->
```

Rules:
- If `AGENTS.md` does not exist, Baton creates it.
- If `AGENTS.md` already exists, Baton preserves the user’s non-Baton content and refreshes the Baton block.
- Baton rejects malformed Baton markers instead of guessing how to rewrite the file.
- Baton rejects multiple Baton blocks.

## Git hook behavior
When a repository is touched, Baton installs `pre-commit` and `post-commit` hooks.

`pre-commit` behavior:
- It validates the Baton block in the worktree before doing anything else.
- It never stages `AGENTS.md` from the worktree.
- If `AGENTS.md` is already staged, it strips the Baton block from the staged version only.
- If stripping leaves staged user content, that stripped content remains staged.
- If stripping leaves the file empty and Baton originally created `AGENTS.md`, the staged file is removed.
- If stripping leaves the file empty but `AGENTS.md` existed before Baton touched the repo, an empty staged file is preserved.

`post-commit` behavior:
- It restores the Baton block in the worktree after the commit completes.

## Running project scripts
Run a script from the current project’s `baton.json` with:

```bash
baton run <script>
```

Resolution rules:
- Baton first checks whether the current repository was previously touched and uses that touched-project mapping.
- If the repository is not in Baton’s local touched state, Baton falls back to matching by normalized `origin` URL.
- The script runs in the current working directory, not inside `~/.baton`.

## Sync behavior
Sync private specs with:

```bash
baton sync [--create]
```

Behavior:
- `--create` bootstraps `~/.baton` and the remote `baton-specs` repository when needed.
- Baton stages and commits local changes in `~/.baton` if necessary.
- Baton pulls and pushes the current checked-out branch.

## Listing projects
List registered projects and touched repositories with:

```bash
baton ls
```

Output includes:
- the project id
- the normalized GitHub URL
- any currently known touched repository roots

## Data layout
Example `~/.baton` tree:

```text
~/.baton/
  pet-project/
    baton.json
    README.md
    CODESTYLE.md
  work-project/
    baton.json
    README.md
    docs/
      A.md
      B.md
```

Notes:
- Baton’s local state is stored under `~/.baton/.baton-local/`.
- Local state is excluded from git.
- Working repositories contain symlinks only; the canonical specs live in `~/.baton`.

## Validation and failure behavior
- Baton validates loaded `baton.json` files instead of trusting raw JSON.
- Baton validates local Baton state instead of trusting raw JSON.
- Baton rejects malformed GitHub URLs.
- Baton rejects malformed Baton marker blocks instead of silently truncating user content.
