import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, test } from "vitest";
import {
  ensureTaskRepo,
  resolveClaimedItemTarget,
} from "./task-target.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function makeRepo(name: string): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), `${name}-`));
  git(["init", "-b", "main"], repoRoot);
  git(["config", "user.name", "Test User"], repoRoot);
  git(["config", "user.email", "test@example.com"], repoRoot);
  writeFileSync(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  git(["add", "README.md"], repoRoot);
  git(["commit", "-m", "init"], repoRoot);
  return repoRoot;
}

describe("claimed item target resolution", () => {
  test("uses explicit repo metadata when present", () => {
    const sharedTodoRepoRoot = makeRepo("workers-shared-todo");
    const targetRepo = path.join(sharedTodoRepoRoot, "target-repo");
    const item = `- Fix workers docs
  - Type: Development task
  - Repo: ./target-repo`;

    const target = resolveClaimedItemTarget(
      item,
      "development-task",
      sharedTodoRepoRoot,
    );

    expect(target.repoPath).toBe(targetRepo);
    expect(target.source).toBe("repo-field");
  });

  test("falls back to backticked path in the summary", () => {
    const sharedTodoRepoRoot = makeRepo("workers-summary-path");
    const item = "- Build plugin in `~/codex-openviking`\n  - Type: New project";

    const target = resolveClaimedItemTarget(
      item,
      "new-project",
      sharedTodoRepoRoot,
    );

    expect(target.repoPath).toBe(path.join(process.env.HOME!, "codex-openviking"));
    expect(target.source).toBe("summary-path");
  });

  test("throws when a non-new-project task omits repo metadata", () => {
    const sharedTodoRepoRoot = makeRepo("workers-invocation");
    const item = "- Update workers docs\n  - Type: Development task";

    expect(() =>
      resolveClaimedItemTarget(
        item,
        "development-task",
        sharedTodoRepoRoot,
      ),
    ).toThrow(/missing a target repo path/i);
  });

  test("supports explicit no-repo tasks via Repo: none", async () => {
    const sharedTodoRepoRoot = makeRepo("workers-no-repo");
    const item = `- Tidy task tracker metadata
  - Type: Development task
  - Repo: none`;

    const target = resolveClaimedItemTarget(
      item,
      "development-task",
      sharedTodoRepoRoot,
    );
    const ensured = await ensureTaskRepo(target);

    expect(target.source).toBe("no-repo");
    expect(ensured.repoRoot).toContain(path.join(".workers", "no-repo"));
    expect(existsSync(path.join(ensured.repoRoot, ".git"))).toBe(true);
  });

  test("bootstraps a new git repo for new-project tasks", async () => {
    const sharedTodoRepoRoot = makeRepo("workers-bootstrap");
    const targetPath = path.join(sharedTodoRepoRoot, "fresh-project");
    const item = `- Create fresh project
  - Type: New project
  - Repo: ./fresh-project`;

    const target = resolveClaimedItemTarget(
      item,
      "new-project",
      sharedTodoRepoRoot,
    );
    const ensured = await ensureTaskRepo(target);

    expect(ensured.bootstrapped).toBe(true);
    expect(existsSync(path.join(targetPath, ".git"))).toBe(true);
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], targetPath)).toBe("main");
    expect(git(["rev-parse", "--verify", "HEAD"], targetPath)).not.toBe("");
  });
});
