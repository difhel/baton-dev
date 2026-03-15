#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type BatonProjectConfig = {
  id: string;
  githubUrl: string;
  scripts?: Record<string, string>;
};

type TouchedRepo = {
  projectId: string;
  repoRoot: string;
  updatedAt: string;
};

type LocalState = {
  version: 1;
  touchedRepos: Record<string, TouchedRepo>;
};

const BATON_BLOCK = [
  "<!-- baton:start -->",
  "You must read `.baton-specs/README.md`",
  "<!-- baton:end -->",
].join("\n");

const BATON_LOCAL_DIRNAME = ".baton-local";
const LOCAL_STATE_FILENAME = "state.json";
const SYMLINK_NAME = ".baton-specs";
const BATON_START_MARKER = "<!-- baton:start -->";
const BATON_END_MARKER = "<!-- baton:end -->";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case "ls":
        await handleLs();
        break;
      case "add":
        await handleAdd(args.slice(1));
        break;
      case "touch":
        await handleTouch(args.slice(1));
        break;
      case "sync":
        await handleSync(args.slice(1));
        break;
      case "run":
        await handleRun(args.slice(1));
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        printHelp();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`baton: ${message}`);
    process.exit(1);
  }
}

async function handleLs() {
  if (!fs.existsSync(getBatonRoot())) {
    console.log("No specs repo found at ~/.baton");
    return;
  }

  const projects = loadProjects();
  const state = loadLocalState();
  const touchedByProject = new Map<string, TouchedRepo[]>();

  for (const entry of Object.values(state.touchedRepos)) {
    const items = touchedByProject.get(entry.projectId) ?? [];
    items.push(entry);
    touchedByProject.set(entry.projectId, items);
  }

  if (projects.length === 0) {
    console.log("No projects added");
    return;
  }

  for (const project of projects.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`${project.id} ${project.githubUrl}`);
    const touched = (touchedByProject.get(project.id) ?? []).sort((a, b) =>
      a.repoRoot.localeCompare(b.repoRoot),
    );

    if (touched.length === 0) {
      console.log("  touched: none");
      continue;
    }

    for (const repo of touched) {
      console.log(`  ${repo.repoRoot}`);
    }
  }
}

async function handleAdd(args: string[]) {
  if (args.length !== 2) {
    throw new Error("Usage: baton add {id} {path|url}");
  }

  ensureSpecsRepoReady();

  const [id, source] = args;
  validateProjectId(id);
  const githubUrl = resolveGithubUrlFromSource(source);
  const existingProjects = loadProjects();

  const duplicateId = existingProjects.find((project) => project.id === id);
  if (duplicateId) {
    throw new Error(`Project id already exists: ${id}`);
  }

  const duplicateUrl = existingProjects.find(
    (project) => normalizeGithubUrl(project.githubUrl) === normalizeGithubUrl(githubUrl),
  );
  if (duplicateUrl) {
    throw new Error(`Project already exists for ${githubUrl} as ${duplicateUrl.id}`);
  }

  const projectDir = getProjectDir(id);
  fs.mkdirSync(projectDir, { recursive: true });

  writeJsonFile(path.join(projectDir, "baton.json"), {
    id,
    githubUrl,
    scripts: {},
  });

  const readmePath = path.join(projectDir, "README.md");
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# ${id}\n\nProject-specific Baton specs live here.\n`);
  }

  console.log(`Added ${id}`);
}

async function handleTouch(args: string[]) {
  if (args.length > 1) {
    throw new Error("Usage: baton touch [id]");
  }

  ensureSpecsRepoReady();

  const repoRoot = getRequiredGitRepoRoot(process.cwd());
  const project = args[0]
    ? getProjectById(args[0])
    : getProjectByOriginUrl(getRepoOriginUrl(repoRoot));

  const linkPath = path.join(repoRoot, SYMLINK_NAME);
  const targetPath = getProjectDir(project.id);
  ensureSymlink(linkPath, targetPath);
  ensureGitInfoExclude(repoRoot, SYMLINK_NAME);

  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const localState = loadLocalState();
  const existingAgentsContent = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, "utf8")
    : null;

  writeTouchedAgentsFile(agentsPath, existingAgentsContent);
  installGitHooks(repoRoot);

  localState.touchedRepos[repoRoot] = {
    projectId: project.id,
    repoRoot,
    updatedAt: new Date().toISOString(),
  };
  saveLocalState(localState);

  console.log(`Touched ${project.id} at ${repoRoot}`);
}

async function handleSync(args: string[]) {
  const create = args.includes("--create");
  if (args.length > 1 || (args.length === 1 && !create)) {
    throw new Error("Usage: baton sync [--create]");
  }

  if (create) {
    ensureSpecsRepoCreated();
  }

  ensureSpecsRepoReady();
  ensureLocalStateIgnored();
  commitPendingSpecsChanges();

  if (remoteHasHeads(getBatonRoot(), "origin")) {
    runCommand(["git", "pull", "--rebase"], getBatonRoot());
  } else {
    ensureLocalCommitExists(getBatonRoot());
  }

  runCommand(["git", "push", "-u", "origin", "HEAD"], getBatonRoot());

  console.log(`Synced ${getBatonRoot()}`);
}

async function handleRun(args: string[]) {
  if (args.length !== 1) {
    throw new Error("Usage: baton run {script}");
  }

  ensureSpecsRepoReady();

  const repoRoot = getRequiredGitRepoRoot(process.cwd());
  const project = getProjectForRepo(repoRoot);
  const scriptName = args[0];
  const script = project.scripts?.[scriptName];

  if (!script) {
    throw new Error(`Script not found: ${scriptName}`);
  }

  const result = spawnProcess(["zsh", "-lc", script], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

function printHelp() {
  console.log(`baton

Commands:
  baton ls
  baton add <id> <path|url>
  baton touch [id]
  baton sync [--create]
  baton run <script>
`);
}

function getBatonRoot() {
  return path.join(os.homedir(), ".baton");
}

function getLocalStatePath() {
  return path.join(getBatonRoot(), BATON_LOCAL_DIRNAME, LOCAL_STATE_FILENAME);
}

function getProjectDir(id: string) {
  return path.join(getBatonRoot(), id);
}

function ensureSpecsRepoReady() {
  const batonRoot = getBatonRoot();
  if (!fs.existsSync(batonRoot) || !isGitRepo(batonRoot)) {
    throw new Error("~/.baton is not ready. Run `baton sync --create` first.");
  }

  ensureLocalStateIgnored();
}

function ensureSpecsRepoCreated() {
  const batonRoot = getBatonRoot();

  if (!fs.existsSync(batonRoot)) {
    const login = getGithubLogin();
    const repoName = `${login}/baton-specs`;

    if (!githubRepoExists(repoName)) {
      runCommand(["gh", "repo", "create", repoName, "--private"], process.cwd());
    }

    runCommand(["gh", "repo", "clone", repoName, batonRoot], process.cwd());
    ensureLocalStateIgnored();
    return;
  }

  if (!isGitRepo(batonRoot)) {
    throw new Error("~/.baton exists but is not a git repo");
  }

  if (hasGitRemote(batonRoot, "origin")) {
    ensureLocalStateIgnored();
    return;
  }

  const login = getGithubLogin();
  const repoName = `${login}/baton-specs`;
  if (githubRepoExists(repoName)) {
    runCommand(["git", "remote", "add", "origin", `https://github.com/${repoName}.git`], batonRoot);
  } else {
    runCommand(
      ["gh", "repo", "create", repoName, "--private", "--source", batonRoot, "--remote", "origin", "--push"],
      process.cwd(),
    );
  }

  ensureLocalStateIgnored();
}

function getGithubLogin() {
  const result = runCommand(["gh", "api", "user", "--jq", ".login"], process.cwd());
  return result.stdout.trim();
}

function githubRepoExists(repoName: string) {
  const result = spawnProcess(["gh", "repo", "view", repoName], {
    stdout: "pipe",
    stderr: "pipe",
  });

  return result.exitCode === 0;
}

function ensureLocalStateIgnored() {
  const batonRoot = getBatonRoot();
  const localDir = path.join(batonRoot, BATON_LOCAL_DIRNAME);
  fs.mkdirSync(localDir, { recursive: true });

  const excludePath = path.join(batonRoot, ".git", "info", "exclude");
  appendLineIfMissing(excludePath, `${BATON_LOCAL_DIRNAME}/`);
}

function loadProjects() {
  const batonRoot = getBatonRoot();
  if (!fs.existsSync(batonRoot)) {
    return [] as BatonProjectConfig[];
  }

  return fs
    .readdirSync(batonRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(batonRoot, entry.name, "baton.json"))
    .filter((configPath) => fs.existsSync(configPath))
    .map((configPath) => ensureProjectConfig(readJsonFile(configPath), configPath));
}

function getProjectById(id: string) {
  const project = loadProjects().find((item) => item.id === id);
  if (!project) {
    throw new Error(`Project not found: ${id}`);
  }

  return project;
}

function getProjectByOriginUrl(originUrl: string) {
  const normalized = normalizeGithubUrl(originUrl);
  const project = loadProjects().find(
    (item) => normalizeGithubUrl(item.githubUrl) === normalized,
  );

  if (!project) {
    throw new Error(`No project matches origin URL: ${originUrl}`);
  }

  return project;
}

function getProjectForRepo(repoRoot: string) {
  const localState = loadLocalState();
  const touched = localState.touchedRepos[repoRoot];

  if (touched) {
    return getProjectById(touched.projectId);
  }

  return getProjectByOriginUrl(getRepoOriginUrl(repoRoot));
}

function resolveGithubUrlFromSource(source: string) {
  if (looksLikeUrl(source)) {
    return normalizeGithubUrl(source);
  }

  const sourcePath = path.resolve(source);
  const repoRoot = getRequiredGitRepoRoot(sourcePath);
  return normalizeGithubUrl(getRepoOriginUrl(repoRoot));
}

function looksLikeUrl(source: string) {
  return (
    source.startsWith("https://") ||
    source.startsWith("http://") ||
    source.startsWith("git@") ||
    source.startsWith("ssh://")
  );
}

function normalizeGithubUrl(input: string) {
  const trimmed = input.trim();

  const match = [
    /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/i,
    /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i,
  ]
    .map((pattern) => trimmed.match(pattern))
    .find((value) => value !== null);

  if (!match) {
    throw new Error(`Only GitHub URLs are supported: ${input}`);
  }

  const owner = match[1];
  const repo = match[2];

  return `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function getRequiredGitRepoRoot(startDir: string) {
  const result = spawnProcess(["git", "rev-parse", "--show-toplevel"], {
    cwd: startDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`${startDir} is not inside a git repo`);
  }

  return result.stdout.trim();
}

function getRepoOriginUrl(repoRoot: string) {
  const result = runCommand(["git", "remote", "get-url", "origin"], repoRoot);
  return result.stdout.trim();
}

function ensureSymlink(linkPath: string, targetPath: string) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Project specs are missing: ${targetPath}`);
  }

  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a symlink`);
    }

    const currentTarget = fs.readlinkSync(linkPath);
    const resolvedCurrent = path.resolve(path.dirname(linkPath), currentTarget);
    if (resolvedCurrent === targetPath) {
      return;
    }

    fs.unlinkSync(linkPath);
  }

  fs.symlinkSync(targetPath, linkPath, "dir");
}

function ensureGitInfoExclude(repoRoot: string, entry: string) {
  const excludePath = resolveGitPath(repoRoot, "info/exclude");
  appendLineIfMissing(excludePath, entry.trim());
}

function writeTouchedAgentsFile(agentsPath: string, existingContent: string | null) {
  const stripped = stripBatonBlock(existingContent ?? "");
  const hasUserContent = stripped.trim().length > 0;
  const preservedContent = stripped.replace(/^\n+/, "").replace(/\n+$/, "");
  const nextContent = hasUserContent
    ? `${BATON_BLOCK}\n\n${preservedContent}\n`
    : `${BATON_BLOCK}\n`;
  fs.writeFileSync(agentsPath, nextContent);
}

function stripBatonBlock(content: string) {
  return stripMarkedBlock(content, BATON_START_MARKER, BATON_END_MARKER, "AGENTS.md");
}

function installGitHooks(repoRoot: string) {
  const hooksDir = resolveGitPath(repoRoot, "hooks");
  const helperPath = path.join(hooksDir, "baton-hook.sh");

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(helperPath, getHookHelperScript());
  fs.chmodSync(helperPath, 0o755);

  ensureHookContains(repoRoot, "pre-commit", `"$(dirname "$0")/baton-hook.sh" pre-commit || exit $?`);
  ensureHookContains(repoRoot, "post-commit", `"$(dirname "$0")/baton-hook.sh" post-commit || exit $?`);
}

function ensureHookContains(repoRoot: string, hookName: string, hookCommand: string) {
  const hookPath = resolveGitPath(repoRoot, path.join("hooks", hookName));
  const markerStart = "# baton:start";
  const markerEnd = "# baton:end";
  const batonSection = `${markerStart}\n${hookCommand}\n${markerEnd}`;

  let content = "";
  if (fs.existsSync(hookPath)) {
    content = fs.readFileSync(hookPath, "utf8");
    content = stripHookSection(content, markerStart, markerEnd);
  } else {
    content = "#!/bin/sh\n";
  }

  if (!content.startsWith("#!")) {
    content = `#!/bin/sh\n${content}`;
  }

  const trimmed = content.trimEnd();
  const next = `${trimmed}\n\n${batonSection}\n`;
  fs.writeFileSync(hookPath, next);
  fs.chmodSync(hookPath, 0o755);
}

function stripHookSection(content: string, startMarker: string, endMarker: string) {
  return stripMarkedBlock(content, startMarker, endMarker, "hook file");
}

function getHookHelperScript() {
  return `#!/bin/sh
set -eu

ACTION="$1"
REPO_ROOT="$(git rev-parse --show-toplevel)"
AGENTS_PATH="$REPO_ROOT/AGENTS.md"
BATON_DIR="$(git rev-parse --git-path baton)"
RESTORE_PATH="$BATON_DIR/agents.restore"
AGENTS_RELATIVE_PATH="AGENTS.md"

mkdir -p "$BATON_DIR"

validate_baton_block() {
  awk '
    $0 == "<!-- baton:start -->" {
      if (inside == 1 || starts > 0) {
        exit 1
      }
      inside = 1
      starts += 1
      next
    }
    $0 == "<!-- baton:end -->" {
      if (inside != 1) {
        exit 1
      }
      inside = 0
      ends += 1
      next
    }
    { next }
    END {
      if (inside == 1 || starts != ends || starts > 1) {
        exit 1
      }
    }
  ' "$1" >/dev/null
}

strip_block() {
  validate_baton_block "$1"
  awk '
    $0 == "<!-- baton:start -->" { inside = 1; next }
    $0 == "<!-- baton:end -->" { inside = 0; next }
    inside != 1 { print }
  ' "$1"
}

normalize_stripped_file() {
  awk '
    started == 0 && NF == 0 { next }
    { started = 1; print }
  ' "$1"
}

restore_worktree() {
  if [ -f "$RESTORE_PATH" ]; then
    cp "$RESTORE_PATH" "$AGENTS_PATH"
  fi
}

is_agents_staged() {
  git diff --cached --name-only --diff-filter=ACMR -- "$AGENTS_RELATIVE_PATH" | grep -qx "$AGENTS_RELATIVE_PATH"
}

write_index_from_file() {
  source_path="$1"
  blob_hash="$(git hash-object -w "$source_path")"
  git update-index --add --cacheinfo 100644 "$blob_hash" "$AGENTS_RELATIVE_PATH"
}

case "$ACTION" in
  pre-commit)
    if [ ! -f "$AGENTS_PATH" ]; then
      rm -f "$RESTORE_PATH"
      exit 0
    fi

    if grep -q "<!-- baton:start -->" "$AGENTS_PATH" || grep -q "<!-- baton:end -->" "$AGENTS_PATH"; then
      validate_baton_block "$AGENTS_PATH"
    else
      rm -f "$RESTORE_PATH"
      exit 0
    fi

    cp "$AGENTS_PATH" "$RESTORE_PATH"

    if ! is_agents_staged; then
      exit 0
    fi

    STAGED_PATH="$BATON_DIR/agents.staged"
    TMP_PATH="$BATON_DIR/agents.stripped"
    trap 'rm -f "$TMP_PATH" "$STAGED_PATH"' EXIT

    git show ":$AGENTS_RELATIVE_PATH" > "$STAGED_PATH"
    strip_block "$STAGED_PATH" | normalize_stripped_file /dev/stdin > "$TMP_PATH"

    if [ -s "$TMP_PATH" ]; then
      write_index_from_file "$TMP_PATH"
    else
      if ! git cat-file -e "HEAD:$AGENTS_RELATIVE_PATH" 2>/dev/null; then
        git rm --cached --quiet --force --ignore-unmatch -- "$AGENTS_RELATIVE_PATH" >/dev/null 2>&1 || true
      else
        : > "$TMP_PATH"
        write_index_from_file "$TMP_PATH"
      fi
    fi
    ;;
  post-commit)
    restore_worktree
    rm -f "$RESTORE_PATH"
    ;;
esac
`;
}

function loadLocalState(): LocalState {
  const statePath = getLocalStatePath();
  if (!fs.existsSync(statePath)) {
    return {
      version: 1,
      touchedRepos: {},
    };
  }

  return ensureLocalState(readJsonFile(statePath), statePath);
}

function saveLocalState(state: LocalState) {
  const statePath = getLocalStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeJsonFile(statePath, state);
}

function writeJsonFile(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function validateProjectId(id: string) {
  if (!/^[a-z0-9._-]+$/i.test(id)) {
    throw new Error("Project id must contain only letters, numbers, dot, underscore, or dash");
  }
}

function appendLineIfMissing(filePath: string, line: string) {
  let content = "";
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf8");
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  if (!content.split("\n").includes(line)) {
    const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(filePath, `${content}${prefix}${line}\n`);
  }
}

function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

function ensureProjectConfig(value: unknown, source: string): BatonProjectConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid project config in ${source}: expected an object`);
  }

  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new Error(`Invalid project config in ${source}: id must be a non-empty string`);
  }

  if (typeof value.githubUrl !== "string" || value.githubUrl.trim().length === 0) {
    throw new Error(`Invalid project config in ${source}: githubUrl must be a non-empty string`);
  }

  validateProjectId(value.id);

  let scripts: Record<string, string> | undefined;
  if (value.scripts !== undefined) {
    if (!isRecord(value.scripts) || Object.values(value.scripts).some((item) => typeof item !== "string")) {
      throw new Error(`Invalid project config in ${source}: scripts must be a string map`);
    }

    scripts = Object.fromEntries(
      Object.entries(value.scripts).map(([key, item]) => [key, item as string]),
    );
  }

  return {
    id: value.id,
    githubUrl: normalizeGithubUrl(value.githubUrl),
    scripts,
  };
}

function ensureLocalState(value: unknown, source: string): LocalState {
  if (!isRecord(value)) {
    throw new Error(`Invalid local state in ${source}: expected an object`);
  }

  if (value.version !== 1) {
    throw new Error(`Invalid local state in ${source}: version must be 1`);
  }

  if (!isRecord(value.touchedRepos)) {
    throw new Error(`Invalid local state in ${source}: touchedRepos must be an object`);
  }

  const touchedRepos = Object.fromEntries(
    Object.entries(value.touchedRepos).map(([repoRoot, item]) => {
      if (!isRecord(item)) {
        throw new Error(`Invalid local state in ${source}: touched repo ${repoRoot} must be an object`);
      }

      if (typeof item.projectId !== "string" || typeof item.repoRoot !== "string") {
        throw new Error(`Invalid local state in ${source}: touched repo ${repoRoot} has invalid ids`);
      }

      if (typeof item.updatedAt !== "string") {
        throw new Error(`Invalid local state in ${source}: touched repo ${repoRoot} has invalid metadata`);
      }

      return [
        repoRoot,
        {
          projectId: item.projectId,
          repoRoot: item.repoRoot,
          updatedAt: item.updatedAt,
        } satisfies TouchedRepo,
      ];
    }),
  );

  return {
    version: 1,
    touchedRepos,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripMarkedBlock(content: string, startMarker: string, endMarker: string, context: string) {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let inside = false;
  let blockCount = 0;

  for (const line of lines) {
    if (line === startMarker) {
      if (inside || blockCount > 0) {
        throw new Error(`Malformed Baton block in ${context}`);
      }

      inside = true;
      blockCount += 1;
      continue;
    }

    if (line === endMarker) {
      if (!inside) {
        throw new Error(`Malformed Baton block in ${context}`);
      }

      inside = false;
      continue;
    }

    if (!inside) {
      kept.push(line);
    }
  }

  if (inside) {
    throw new Error(`Malformed Baton block in ${context}`);
  }

  return kept.join("\n");
}

function isGitRepo(dir: string) {
  return fs.existsSync(path.join(dir, ".git"));
}

function resolveGitPath(repoRoot: string, relativePath: string) {
  const result = runCommand(["git", "rev-parse", "--git-path", relativePath], repoRoot);
  const gitPath = result.stdout.trim();
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot, gitPath);
}

function hasGitRemote(repoRoot: string, remoteName: string) {
  const result = spawnProcess(["git", "remote", "get-url", remoteName], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  return result.exitCode === 0;
}

function commitPendingSpecsChanges() {
  runCommand(["git", "add", "-A"], getBatonRoot());
  const diffResult = spawnProcess(["git", "diff", "--cached", "--quiet"], {
    cwd: getBatonRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });

  if (diffResult.exitCode === 0) {
    return;
  }

  if (diffResult.exitCode !== 1) {
    throw new Error("Failed to inspect pending spec changes");
  }

  runCommand(
    ["git", "commit", "-m", `baton sync ${new Date().toISOString()}`],
    getBatonRoot(),
  );
}

function ensureLocalCommitExists(repoRoot: string) {
  if (hasLocalCommit(repoRoot)) {
    return;
  }

  runCommand(["git", "commit", "--allow-empty", "-m", "Initialize baton specs"], repoRoot);
}

function hasLocalCommit(repoRoot: string) {
  const result = spawnProcess(["git", "rev-parse", "--verify", "HEAD"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  return result.exitCode === 0;
}

function remoteHasHeads(repoRoot: string, remoteName: string) {
  const result = spawnProcess(["git", "ls-remote", "--exit-code", "--heads", remoteName], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  return result.exitCode === 0;
}

function runCommand(cmd: string[], cwd: string) {
  const result = spawnProcess(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    throw new Error(stderr || stdout || `Command failed: ${cmd.join(" ")}`);
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function spawnProcess(
  cmd: string[],
  options: {
    cwd?: string;
    stdout?: "pipe" | "inherit";
    stderr?: "pipe" | "inherit";
    stdio?: "inherit";
  } = {},
) {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: options.cwd,
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
  });

  return {
    exitCode: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

await main();
