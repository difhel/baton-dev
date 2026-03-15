import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI_PATH = path.join(import.meta.dir, "index.ts");
const tempRoots: string[] = [];

afterEach(() => {
  const root = tempRoots.pop();
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("baton CLI", () => {
  test("add registers a project from a local repo path", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "git@github.com:Example/MyRepo.git");
    createMockBatonRepo(env.homeDir);

    const result = runCli(env, ["add", "demo", env.repoDir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added demo");

    const config = readJson(path.join(env.homeDir, ".baton", "demo", "baton.json"));
    expect(config).toEqual({
      id: "demo",
      githubUrl: "https://github.com/example/myrepo",
      scripts: {},
    });

    expect(fs.readFileSync(path.join(env.homeDir, ".baton", "demo", "README.md"), "utf8")).toContain(
      "# demo",
    );
  });

  test("touch links specs and injects exactly one baton block", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/Example/MyRepo.git");
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, "baton.json"), {
      id: "demo",
      githubUrl: "https://github.com/example/myrepo",
      scripts: {},
    });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# demo\n");
    fs.writeFileSync(
      path.join(env.repoDir, "AGENTS.md"),
      [
        "Existing instructions",
        "",
        "<!-- baton:start -->",
        "stale block",
        "<!-- baton:end -->",
        "",
      ].join("\n"),
    );

    const result = runCli(env, ["touch"], { cwd: env.repoDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Touched demo at ${fs.realpathSync(env.repoDir)}`);

    const linkPath = path.join(env.repoDir, ".baton-specs");
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(projectDir);

    const agents = fs.readFileSync(path.join(env.repoDir, "AGENTS.md"), "utf8");
    expect(agents.match(/<!-- baton:start -->/g)?.length ?? 0).toBe(1);
    expect(agents).toContain("You must read `.baton-specs/README.md`");
    expect(agents).toContain("Existing instructions");
    expect(agents).not.toContain("stale block");

    const exclude = fs.readFileSync(path.join(env.repoDir, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".baton-specs");

    expect(fs.existsSync(path.join(env.repoDir, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(fs.existsSync(path.join(env.repoDir, ".git", "hooks", "post-commit"))).toBe(true);
    expect(fs.existsSync(path.join(env.repoDir, ".git", "hooks", "baton-hook.sh"))).toBe(true);

    const state = readJson(path.join(env.homeDir, ".baton", ".baton-local", "state.json"));
    expect(state.touchedRepos[fs.realpathSync(env.repoDir)].projectId).toBe("demo");
  });

  test("end-to-end workflow uses add, touch, ls, and run together", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/example/workflow.git");
    createMockBatonRepo(env.homeDir);

    const addResult = runCli(env, ["add", "workflow", env.repoDir]);
    expect(addResult.exitCode).toBe(0);
    expect(addResult.stdout).toContain("Added workflow");

    updateProjectScripts(env.homeDir, "workflow", {
      smoke: "pwd > workflow.out",
    });

    const touchResult = runCli(env, ["touch"], { cwd: env.repoDir });
    expect(touchResult.exitCode).toBe(0);
    expect(touchResult.stdout).toContain("Touched workflow");

    const lsResult = runCli(env, ["ls"]);
    expect(lsResult.exitCode).toBe(0);
    expect(lsResult.stdout).toContain("workflow https://github.com/example/workflow");
    expect(lsResult.stdout).toContain(fs.realpathSync(env.repoDir));

    const runResult = runCli(env, ["run", "smoke"], { cwd: env.repoDir });
    expect(runResult.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(env.repoDir, "workflow.out"), "utf8").trim()).toBe(
      fs.realpathSync(env.repoDir),
    );

    const agents = fs.readFileSync(path.join(env.repoDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("You must read `.baton-specs/README.md`");
    expect(fs.lstatSync(path.join(env.repoDir, ".baton-specs")).isSymbolicLink()).toBe(true);
  });

  test("sync --create bootstraps the specs repo through mocked gh and git", () => {
    const env = createChroot();

    const result = runCli(env, ["sync", "--create"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Synced ${path.join(env.homeDir, ".baton")}`);
    expect(fs.existsSync(path.join(env.homeDir, ".baton", ".git"))).toBe(true);

    const ghLog = fs.readFileSync(path.join(env.rootDir, "gh.log"), "utf8");
    expect(ghLog).toContain("api user --jq .login");
    expect(ghLog).toContain("repo view mock-user/baton-specs");
    expect(ghLog).toContain("repo create mock-user/baton-specs");
    expect(ghLog).toContain("repo clone mock-user/baton-specs");

    const gitLog = fs.readFileSync(path.join(env.rootDir, "git.log"), "utf8");
    expect(gitLog).toContain("branch --show-current");
    expect(gitLog).toContain("add -A");
    expect(gitLog).toContain("diff --cached --quiet");
    expect(gitLog).toContain("pull");
    expect(gitLog).toContain("push");
  });

  test("ls shows projects and touched repos", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/example/myrepo.git");
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, "baton.json"), {
      id: "demo",
      githubUrl: "https://github.com/example/myrepo",
      scripts: {},
    });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# demo\n");

    const touchResult = runCli(env, ["touch"], { cwd: env.repoDir });
    expect(touchResult.exitCode).toBe(0);

    const lsResult = runCli(env, ["ls"]);
    expect(lsResult.exitCode).toBe(0);
    expect(lsResult.stdout).toContain("demo https://github.com/example/myrepo");
    expect(lsResult.stdout).toContain(fs.realpathSync(env.repoDir));
  });

  test("run uses the touched repo mapping instead of resolving only from origin", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/example/unrelated.git");
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, "baton.json"), {
      id: "demo",
      githubUrl: "https://github.com/example/demo.git",
      scripts: {
        smoke: "pwd > script.out",
      },
    });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# demo\n");

    const touchResult = runCli(env, ["touch", "demo"], { cwd: env.repoDir });
    expect(touchResult.exitCode).toBe(0);

    const runResult = runCli(env, ["run", "smoke"], { cwd: env.repoDir });
    expect(runResult.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(env.repoDir, "script.out"), "utf8").trim()).toBe(
      fs.realpathSync(env.repoDir),
    );
  });

  test("pre-commit rewrites only the staged AGENTS.md and does not auto-stage an unstaged file", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/example/myrepo.git");
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, "baton.json"), {
      id: "demo",
      githubUrl: "https://github.com/example/myrepo",
      scripts: {},
    });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# demo\n");

    const touchResult = runCli(env, ["touch"], { cwd: env.repoDir });
    expect(touchResult.exitCode).toBe(0);

    const agentsPath = path.join(env.repoDir, "AGENTS.md");
    const worktreeAgents = [
      "<!-- baton:start -->",
      "You must read `.baton-specs/README.md`",
      "<!-- baton:end -->",
      "",
      "Unstaged worktree instructions",
      "",
    ].join("\n");
    const stagedAgents = [
      "<!-- baton:start -->",
      "You must read `.baton-specs/README.md`",
      "<!-- baton:end -->",
      "",
      "Already staged instructions",
      "",
    ].join("\n");

    fs.writeFileSync(agentsPath, worktreeAgents);
    setMockIndexFile(env.repoDir, "AGENTS.md", stagedAgents);

    const hookResult = Bun.spawnSync({
      cmd: [path.join(env.repoDir, ".git", "hooks", "pre-commit")],
      cwd: env.repoDir,
      env: env.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(hookResult.exitCode).toBe(0);
    expect(fs.readFileSync(agentsPath, "utf8")).toBe(worktreeAgents);
    expect(readMockIndexFile(env.repoDir, "AGENTS.md")).toBe("Already staged instructions\n");

    clearMockIndexFile(env.repoDir, "AGENTS.md");
    const unstagedResult = Bun.spawnSync({
      cmd: [path.join(env.repoDir, ".git", "hooks", "pre-commit")],
      cwd: env.repoDir,
      env: env.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(unstagedResult.exitCode).toBe(0);
    expect(hasMockIndexFile(env.repoDir, "AGENTS.md")).toBe(false);
    expect(fs.readFileSync(agentsPath, "utf8")).toBe(worktreeAgents);
  });

  test("post-commit restores the baton block in the worktree and clears the restore file", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/example/myrepo.git");
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, "baton.json"), {
      id: "demo",
      githubUrl: "https://github.com/example/myrepo",
      scripts: {},
    });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# demo\n");

    const touchResult = runCli(env, ["touch"], { cwd: env.repoDir });
    expect(touchResult.exitCode).toBe(0);

    const agentsPath = path.join(env.repoDir, "AGENTS.md");
    const originalWorktree = fs.readFileSync(agentsPath, "utf8");
    setMockIndexFile(env.repoDir, "AGENTS.md", originalWorktree);

    const preCommit = runHook(env, "pre-commit");
    expect(preCommit.exitCode).toBe(0);

    fs.writeFileSync(agentsPath, "committed form without baton block\n");
    const postCommit = runHook(env, "post-commit");
    expect(postCommit.exitCode).toBe(0);
    expect(fs.readFileSync(agentsPath, "utf8")).toBe(originalWorktree);
    expect(fs.existsSync(path.join(env.repoDir, ".git", "baton", "agents.restore"))).toBe(false);
  });

  test("pre-commit removes staged AGENTS.md when Baton created the file and only the block remains", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/example/myrepo.git");
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, "baton.json"), {
      id: "demo",
      githubUrl: "https://github.com/example/myrepo",
      scripts: {},
    });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# demo\n");

    const touchResult = runCli(env, ["touch"], { cwd: env.repoDir });
    expect(touchResult.exitCode).toBe(0);

    const agentsPath = path.join(env.repoDir, "AGENTS.md");
    const blockOnly = fs.readFileSync(agentsPath, "utf8");
    setMockIndexFile(env.repoDir, "AGENTS.md", blockOnly);

    const hookResult = runHook(env, "pre-commit");
    expect(hookResult.exitCode).toBe(0);
    expect(hasMockIndexFile(env.repoDir, "AGENTS.md")).toBe(false);
    expect(fs.readFileSync(agentsPath, "utf8")).toBe(blockOnly);
  });

  test("pre-commit stages an empty AGENTS.md when the file existed before Baton", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/example/myrepo.git");
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, "baton.json"), {
      id: "demo",
      githubUrl: "https://github.com/example/myrepo",
      scripts: {},
    });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# demo\n");
    fs.writeFileSync(path.join(env.repoDir, "AGENTS.md"), "");
    fs.writeFileSync(getMockHeadPath(env.repoDir, "AGENTS.md"), "");

    const touchResult = runCli(env, ["touch"], { cwd: env.repoDir });
    expect(touchResult.exitCode).toBe(0);

    const agentsPath = path.join(env.repoDir, "AGENTS.md");
    const blockOnly = fs.readFileSync(agentsPath, "utf8");
    setMockIndexFile(env.repoDir, "AGENTS.md", blockOnly);

    const hookResult = runHook(env, "pre-commit");
    expect(hookResult.exitCode).toBe(0);
    expect(readMockIndexFile(env.repoDir, "AGENTS.md")).toBe("");
    expect(fs.readFileSync(agentsPath, "utf8")).toBe(blockOnly);
  });

  test("add rejects GitHub URLs with extra path segments", () => {
    const env = createChroot();
    createMockBatonRepo(env.homeDir);

    const result = runCli(env, ["add", "demo", "https://github.com/example/repo/issues/1"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Only GitHub URLs are supported");
  });

  test("ls fails fast on malformed baton.json", () => {
    const env = createChroot();
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "broken");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "baton.json"), '{"id":123,"githubUrl":"https://github.com/example/repo"}\n');

    const result = runCli(env, ["ls"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid project config");
  });

  test("touch rejects malformed baton blocks instead of truncating AGENTS.md", () => {
    const env = createChroot();
    createMockGitRepo(env.repoDir, "https://github.com/example/myrepo.git");
    createMockBatonRepo(env.homeDir);

    const projectDir = path.join(env.homeDir, ".baton", "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, "baton.json"), {
      id: "demo",
      githubUrl: "https://github.com/example/myrepo",
      scripts: {},
    });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# demo\n");

    const malformed = [
      "Keep this",
      BATON_START_MARKER,
      "broken baton block",
      "Do not delete this",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(env.repoDir, "AGENTS.md"), malformed);

    const result = runCli(env, ["touch"], { cwd: env.repoDir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Malformed Baton block");
    expect(fs.readFileSync(path.join(env.repoDir, "AGENTS.md"), "utf8")).toBe(malformed);
  });
});

function createChroot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "baton-test-"));
  tempRoots.push(rootDir);

  const homeDir = path.join(rootDir, "home");
  const repoDir = path.join(rootDir, "repo");
  const binDir = path.join(rootDir, "bin");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  writeExecutable(path.join(binDir, "git"), createGitMockScript());
  writeExecutable(path.join(binDir, "gh"), createGhMockScript());

  return {
    rootDir,
    homeDir,
    repoDir,
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      MOCK_ROOT: rootDir,
    } satisfies NodeJS.ProcessEnv,
  };
}

function createMockBatonRepo(homeDir: string) {
  const batonRoot = path.join(homeDir, ".baton");
  fs.mkdirSync(path.join(batonRoot, ".git", "info"), { recursive: true });
  fs.mkdirSync(path.join(batonRoot, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(batonRoot, ".mock-branch"), "main\n");
}

function createMockGitRepo(repoDir: string, originUrl: string) {
  fs.mkdirSync(path.join(repoDir, ".git", "info"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".mock-index"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".mock-head"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".mock-objects"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, ".mock-index-meta"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, ".mock-origin"), `${originUrl}\n`);
  fs.writeFileSync(path.join(repoDir, ".mock-branch"), "main\n");
}

function runCli(
  env: ReturnType<typeof createChroot>,
  args: string[],
  options: { cwd?: string } = {},
) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", CLI_PATH, ...args],
    cwd: options.cwd ?? import.meta.dir,
    env: env.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    ...result,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runHook(env: ReturnType<typeof createChroot>, hookName: "pre-commit" | "post-commit") {
  return Bun.spawnSync({
    cmd: [path.join(env.repoDir, ".git", "hooks", hookName)],
    cwd: env.repoDir,
    env: env.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeExecutable(filePath: string, content: string) {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const BATON_START_MARKER = "<!-- baton:start -->";

function updateProjectScripts(
  homeDir: string,
  projectId: string,
  scripts: Record<string, string>,
) {
  const configPath = path.join(homeDir, ".baton", projectId, "baton.json");
  const config = readJson(configPath);
  config.scripts = scripts;
  writeJson(configPath, config);
}

function getMockIndexPath(repoDir: string, relativePath: string) {
  return path.join(repoDir, ".mock-index", relativePath);
}

function getMockHeadPath(repoDir: string, relativePath: string) {
  return path.join(repoDir, ".mock-head", relativePath);
}

function setMockIndexFile(repoDir: string, relativePath: string, content: string) {
  const filePath = getMockIndexPath(repoDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function readMockIndexFile(repoDir: string, relativePath: string) {
  return fs.readFileSync(getMockIndexPath(repoDir, relativePath), "utf8");
}

function clearMockIndexFile(repoDir: string, relativePath: string) {
  fs.rmSync(getMockIndexPath(repoDir, relativePath), { force: true });
}

function hasMockIndexFile(repoDir: string, relativePath: string) {
  return fs.existsSync(getMockIndexPath(repoDir, relativePath));
}

function createGitMockScript() {
  return `#!/bin/sh
set -eu

LOG="$MOCK_ROOT/git.log"
mkdir -p "$(dirname "$LOG")"
printf '%s|%s\\n' "$PWD" "$*" >> "$LOG"

find_repo_root() {
  dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -e "$dir/.git" ]; then
      printf '%s\\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  exit 1
}

mock_path() {
  repo_root="$(find_repo_root)"
  printf '%s\\n' "$repo_root/$1/$2"
}

hash_to_store() {
  input_path="$1"
  shasum "$input_path" | awk '{print $1}'
}

cmd="\${1:-}"
case "$cmd" in
  rev-parse)
    case "\${2:-}" in
      --show-toplevel)
        find_repo_root
        ;;
      --git-path)
        repo_root="$(find_repo_root)"
        printf '%s\\n' "$repo_root/.git/\${3:?}"
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  remote)
    case "\${2:-}" in
      get-url)
        repo_root="$(find_repo_root)"
        cat "$repo_root/.mock-origin"
        ;;
      add)
        repo_root="$(find_repo_root)"
        printf '%s\\n' "\${4:?}" > "$repo_root/.mock-origin"
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  branch)
    if [ "\${2:-}" = "--show-current" ]; then
      repo_root="$(find_repo_root)"
      if [ -f "$repo_root/.mock-branch" ]; then
        cat "$repo_root/.mock-branch"
      else
        printf 'main\\n'
      fi
    else
      exit 1
    fi
    ;;
  add|pull|push)
    ;;
  rm)
    repo_root="$(find_repo_root)"
    rm -f "$(mock_path .mock-index AGENTS.md)"
    ;;
  diff)
    repo_root="$(find_repo_root)"
    if [ "\${2:-}" = "--cached" ] && [ "\${3:-}" = "--name-only" ]; then
      file_path="$(mock_path .mock-index AGENTS.md)"
      if [ -f "$file_path" ]; then
        printf 'AGENTS.md\\n'
      fi
      exit 0
    fi
    if [ -f "$repo_root/.mock-diff-exit" ]; then
      exit "$(cat "$repo_root/.mock-diff-exit")"
    fi
    exit 0
    ;;
  commit)
    repo_root="$(find_repo_root)"
    touch "$repo_root/.mock-commit-ran"
    ;;
  show)
    repo_root="$(find_repo_root)"
    case "\${2:-}" in
      :AGENTS.md)
        cat "$(mock_path .mock-index AGENTS.md)"
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  hash-object)
    if [ "\${2:-}" = "-w" ]; then
      input_path="\${3:-}"
      hash="$(hash_to_store "$input_path")"
      repo_root="$(find_repo_root)"
      object_path="$(mock_path .mock-objects "$hash")"
      mkdir -p "$(dirname "$object_path")"
      cp "$input_path" "$object_path"
      printf '%s\\n' "$hash"
    else
      exit 1
    fi
    ;;
  update-index)
    if [ "\${2:-}" = "--add" ] && [ "\${3:-}" = "--cacheinfo" ]; then
      mode="\${4:-}"
      hash="\${5:-}"
      relative_path="\${6:-}"
      repo_root="$(find_repo_root)"
      object_path="$(mock_path .mock-objects "$hash")"
      index_path="$(mock_path .mock-index "$relative_path")"
      mkdir -p "$(dirname "$index_path")"
      cp "$object_path" "$index_path"
      printf '%s\\n' "$mode" > "$(mock_path .mock-index-meta "$relative_path.mode")"
    else
      exit 1
    fi
    ;;
  cat-file)
    if [ "\${2:-}" = "-e" ] && [ "\${3:-}" = "HEAD:AGENTS.md" ]; then
      if [ -f "$(mock_path .mock-head AGENTS.md)" ]; then
        exit 0
      fi
      exit 1
    else
      exit 1
    fi
    ;;
  *)
    exit 1
    ;;
esac
`;
}

function createGhMockScript() {
  return `#!/bin/sh
set -eu

LOG="$MOCK_ROOT/gh.log"
mkdir -p "$(dirname "$LOG")"
printf '%s|%s\\n' "$PWD" "$*" >> "$LOG"

case "\${1:-}" in
  api)
    if [ "\${2:-}" = "user" ] && [ "\${3:-}" = "--jq" ] && [ "\${4:-}" = ".login" ]; then
      printf 'mock-user\\n'
    else
      exit 1
    fi
    ;;
  repo)
    case "\${2:-}" in
      view)
        if [ -f "$MOCK_ROOT/gh-repo-exists" ]; then
          exit 0
        fi
        exit 1
        ;;
      create)
        touch "$MOCK_ROOT/gh-created"
        ;;
      clone)
        target="\${4:?}"
        mkdir -p "$target/.git/info" "$target/.git/hooks"
        printf 'main\\n' > "$target/.mock-branch"
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  *)
    exit 1
    ;;
esac
`;
}
