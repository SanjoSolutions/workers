import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initGitTodoRepo, promptAndInitTaskTracker, updateShellConfig } from "./init-task-tracker.js";

async function isGitRepo(dir: string): Promise<boolean> {
  return existsSync(path.join(dir, ".git"));
}

describe("initGitTodoRepo", () => {
  test("initializes a new git repo and creates TODO.md with initial commit", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "workers-init-"));
    const repoDir = path.join(tmpDir, "my-todo-repo");

    await initGitTodoRepo(repoDir);

    expect(await isGitRepo(repoDir)).toBe(true);
    expect(existsSync(path.join(repoDir, "TODO.md"))).toBe(true);
  });

  test("does not re-initialize an existing git repo", async () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "workers-init-existing-"));

    // First call creates the repo
    await initGitTodoRepo(repoDir);
    const todoContent = readFileSync(path.join(repoDir, "TODO.md"), "utf8");

    // Second call should not overwrite existing TODO.md
    await initGitTodoRepo(repoDir);
    const todoContentAfter = readFileSync(path.join(repoDir, "TODO.md"), "utf8");

    expect(todoContentAfter).toBe(todoContent);
  });

  test("creates directory if it does not exist", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "workers-init-mkdir-"));
    const repoDir = path.join(tmpDir, "nested", "todo-repo");

    await initGitTodoRepo(repoDir);

    expect(existsSync(repoDir)).toBe(true);
    expect(await isGitRepo(repoDir)).toBe(true);
  });
});

describe("updateShellConfig", () => {
  test("appends WORKERS_TODO_REPO to a new shell config file", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "workers-shellcfg-"));
    const shellConfigPath = path.join(tmpDir, ".bashrc");

    updateShellConfig("/path/to/todo-repo", shellConfigPath);

    const content = readFileSync(shellConfigPath, "utf8");
    expect(content).toContain("export WORKERS_TODO_REPO=/path/to/todo-repo");
  });

  test("replaces an existing WORKERS_TODO_REPO line", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "workers-shellcfg-replace-"));
    const shellConfigPath = path.join(tmpDir, ".bashrc");

    updateShellConfig("/old/path", shellConfigPath);
    updateShellConfig("/new/path", shellConfigPath);

    const content = readFileSync(shellConfigPath, "utf8");
    expect(content).toContain("export WORKERS_TODO_REPO=/new/path");
    expect(content).not.toContain("export WORKERS_TODO_REPO=/old/path");
    // Should appear exactly once
    expect(content.match(/export WORKERS_TODO_REPO=/g)?.length).toBe(1);
  });

  test("preserves existing shell config content", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "workers-shellcfg-preserve-"));
    const shellConfigPath = path.join(tmpDir, ".bashrc");

    writeFileSync(shellConfigPath, "export PATH=$HOME/bin:$PATH\n", "utf8");

    updateShellConfig("/path/to/todo-repo", shellConfigPath);

    const content = readFileSync(shellConfigPath, "utf8");
    expect(content).toContain("export PATH=$HOME/bin:$PATH");
    expect(content).toContain("export WORKERS_TODO_REPO=/path/to/todo-repo");
  });
});

describe("promptAndInitTaskTracker", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.WORKERS_TODO_REPO;
    delete process.env.WORKERS_TODO_REPO;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.WORKERS_TODO_REPO = originalEnv;
    } else {
      delete process.env.WORKERS_TODO_REPO;
    }
  });

  test("initializes git-todo repo and sets process.env.WORKERS_TODO_REPO", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "workers-prompt-init-"));
    const repoDir = path.join(tmpDir, "todo-repo");
    const shellConfigPath = path.join(tmpDir, ".bashrc");

    await promptAndInitTaskTracker(process.cwd(), {
      promptForTrackerType: async () => "git-todo",
      promptForRepoDir: async () => repoDir,
      shellConfigPath,
    });

    expect(process.env.WORKERS_TODO_REPO).toBe(repoDir);
    expect(existsSync(path.join(repoDir, "TODO.md"))).toBe(true);
    const shellContent = readFileSync(shellConfigPath, "utf8");
    expect(shellContent).toContain(`export WORKERS_TODO_REPO=${repoDir}`);
  });

  test("throws when github-issues tracker type is chosen", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "workers-prompt-gh-"));
    const shellConfigPath = path.join(tmpDir, ".bashrc");

    await expect(
      promptAndInitTaskTracker(process.cwd(), {
        promptForTrackerType: async () => "github-issues",
        promptForRepoDir: async () => tmpDir,
        shellConfigPath,
      }),
    ).rejects.toThrow("GitHub Issues setup is not yet supported");
  });

  test("throws in non-TTY when no override is provided", async () => {
    // process.stdin.isTTY is false in test environment
    await expect(
      promptAndInitTaskTracker(process.cwd()),
    ).rejects.toThrow("No task tracker is configured");
  });
});
