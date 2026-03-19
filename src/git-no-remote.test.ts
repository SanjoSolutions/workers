import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, test } from "vitest";
import { selectWorktree } from "./worktree.js";
import { rebaseWorktreeOntoRoot } from "./git-sync.js";
import { cleanup } from "./cleanup.js";
import { resolveBranchTarget } from "./git-target.js";
import { releaseWorktreeLock } from "./locking.js";
import type { CliOptions, WorkConfig } from "./types.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function makeRepo(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "workers-no-remote-"));
  git(["init", "-b", "main"], repoRoot);
  git(["config", "user.name", "Test User"], repoRoot);
  git(["config", "user.email", "test@example.com"], repoRoot);

  writeFileSync(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  git(["add", "README.md"], repoRoot);
  git(["commit", "-m", "init"], repoRoot);

  return repoRoot;
}

function makeRepoWithBareRemote() {
  const repoRoot = makeRepo();
  const remoteRoot = mkdtempSync(path.join(tmpdir(), "workers-remote-"));
  const bareRemote = path.join(remoteRoot, "repo.git");
  git(["init", "--bare", bareRemote], remoteRoot);
  git(["remote", "add", "worker", bareRemote], repoRoot);
  git(["push", "-u", "worker", "main"], repoRoot);
  return { repoRoot, bareRemote };
}

const options: CliOptions = {
  cli: "codex",
  worktreeDir: ".worktrees",
  reuseWorktree: false,
  cleanup: false,
  cleanupStale: false,
  interactive: false,
  noTodo: true,
};

const config: WorkConfig = {
  projectName: "test",
};

describe("git flow with a tracked non-origin remote", () => {
  test("selectWorktree creates a new worktree from the tracked remote branch", async () => {
    const { repoRoot } = makeRepoWithBareRemote();
    const projectWorktreeDir = path.join(repoRoot, ".worktrees", "test-project");
    mkdirSync(path.join(repoRoot, ".git", "worktree-active-locks"), {
      recursive: true,
    });
    const branchTarget = await resolveBranchTarget(repoRoot);

    const result = await selectWorktree(
      repoRoot,
      options,
      "codex-123",
      path.join(repoRoot, ".git", "worktree-active-locks"),
      config,
      branchTarget,
      projectWorktreeDir,
    );

    expect(result.worktree.reuseMode).toBe("new");
    expect(result.worktree.path.startsWith(projectWorktreeDir)).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], result.worktree.path)).toBe(
      result.worktree.branchName,
    );
    expect(git(["rev-parse", "HEAD"], result.worktree.path)).toBe(
      git(["rev-parse", "worker/main"], repoRoot),
    );
  });

  test("rebaseWorktreeOntoRoot syncs against the tracked remote branch", async () => {
    const { repoRoot } = makeRepoWithBareRemote();
    const projectWorktreeDir = path.join(repoRoot, ".worktrees", "test-project");
    mkdirSync(path.join(repoRoot, ".git", "worktree-active-locks"), {
      recursive: true,
    });
    const branchTarget = await resolveBranchTarget(repoRoot);

    const { worktree } = await selectWorktree(
      repoRoot,
      options,
      "codex-124",
      path.join(repoRoot, ".git", "worktree-active-locks"),
      config,
      branchTarget,
      projectWorktreeDir,
    );

    writeFileSync(path.join(repoRoot, "README.md"), "updated on root\n", "utf8");
    git(["add", "README.md"], repoRoot);
    git(["commit", "-m", "root update"], repoRoot);
    git(["push", "worker", "HEAD:main"], repoRoot);

    const synced = await rebaseWorktreeOntoRoot(repoRoot, worktree.path, branchTarget);
    expect(synced).toBe(true);
    expect(git(["rev-parse", "worker/main"], repoRoot)).toBe(
      git(["merge-base", "worker/main", "HEAD"], worktree.path),
    );
  });

  test("cleanup removes the worktree but keeps the worker branch", async () => {
    const { repoRoot } = makeRepoWithBareRemote();
    const projectWorktreeDir = path.join(repoRoot, ".worktrees", "test-project");
    mkdirSync(path.join(repoRoot, ".git", "worktree-active-locks"), {
      recursive: true,
    });
    const branchTarget = await resolveBranchTarget(repoRoot);

    const { worktree } = await selectWorktree(
      repoRoot,
      options,
      "codex-125",
      path.join(repoRoot, ".git", "worktree-active-locks"),
      config,
      branchTarget,
      projectWorktreeDir,
    );

    writeFileSync(path.join(worktree.path, "feature.txt"), "worker change\n", "utf8");
    git(["add", "feature.txt"], worktree.path);
    git(["commit", "-m", "worker change"], worktree.path);

    await cleanup(
      repoRoot,
      { ...options, cleanup: true },
      worktree,
      path.join(repoRoot, ".git", "worktree-active-locks", "unused.lock"),
    );

    const worktreeList = git(["worktree", "list", "--porcelain"], repoRoot);
    expect(worktreeList).not.toContain(worktree.path);
    expect(git(["rev-parse", "--verify", worktree.branchName], repoRoot)).not.toBe("");
  });

  test("reused worker runs switch to a fresh branch for the next claimed task", async () => {
    const { repoRoot } = makeRepoWithBareRemote();
    const projectWorktreeDir = path.join(repoRoot, ".worktrees", "test-project");
    const worktreeLockRoot = path.join(repoRoot, ".git", "worktree-active-locks");
    mkdirSync(worktreeLockRoot, {
      recursive: true,
    });

    const branchTarget = await resolveBranchTarget(repoRoot);
    const workerOptions: CliOptions = {
      ...options,
      noTodo: false,
      reuseWorktree: true,
    };

    const first = await selectWorktree(
      repoRoot,
      workerOptions,
      "codex-127",
      worktreeLockRoot,
      config,
      branchTarget,
      projectWorktreeDir,
    );

    writeFileSync(path.join(first.worktree.path, "feature.txt"), "first task\n", "utf8");
    git(["add", "feature.txt"], first.worktree.path);
    git(["commit", "-m", "first task"], first.worktree.path);
    const firstTaskHead = git(["rev-parse", "HEAD"], first.worktree.path);

    releaseWorktreeLock(first.lockDir);

    const second = await selectWorktree(
      repoRoot,
      workerOptions,
      "codex-128",
      worktreeLockRoot,
      config,
      branchTarget,
      projectWorktreeDir,
    );

    expect(second.worktree.reuseMode).toBe("reused");
    expect(second.worktree.path).toBe(first.worktree.path);
    expect(second.worktree.branchName).toBe("work/codex-128");
    expect(git(["branch", "--show-current"], second.worktree.path)).toBe(
      "work/codex-128",
    );
    expect(git(["rev-parse", "HEAD"], second.worktree.path)).toBe(
      git(["rev-parse", "worker/main"], repoRoot),
    );
    expect(() =>
      git(["merge-base", "--is-ancestor", firstTaskHead, "work/codex-128"], repoRoot),
    ).toThrow();
  });

  test("project repos without an upstream remote still expose a usable local branch target", async () => {
    const repoRoot = makeRepo();
    const projectWorktreeDir = path.join(repoRoot, ".worktrees", "test-project");
    mkdirSync(path.join(repoRoot, ".git", "worktree-active-locks"), {
      recursive: true,
    });

    const branchTarget = await resolveBranchTarget(repoRoot);
    expect(branchTarget).toMatchObject({
      branch: "main",
      hasRemote: false,
    });

    const { worktree } = await selectWorktree(
      repoRoot,
      options,
      "codex-126",
      path.join(repoRoot, ".git", "worktree-active-locks"),
      config,
      branchTarget,
      projectWorktreeDir,
    );

    expect(git(["rev-parse", "HEAD"], worktree.path)).toBe(
      git(["rev-parse", "HEAD"], repoRoot),
    );
  });
});
