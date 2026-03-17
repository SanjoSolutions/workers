import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { $ } from "zx";
import { describe, expect, test } from "vitest";
import { loadSettings } from "../src/settings.js";
import { insertIntoSection } from "../src/add-todo.js";
import { claimFromTodoText } from "../src/claim-todo.js";
import { resolveClaimedTaskTarget, ensureTaskRepo } from "../src/task-target.js";
import { resolvePollingTaskTrackers } from "../src/task-tracker-settings.js";
import { selectWorktree } from "../src/worktree.js";
import { resolveBranchTarget } from "../src/git-target.js";
import { resolveProjectWorktreeDir } from "../src/worktree-paths.js";

async function createFakeCli(binDir: string, name: string): Promise<void> {
  const { mkdir, writeFile, chmod } = await import("fs/promises");
  await mkdir(binDir, { recursive: true });
  const filePath = path.join(binDir, name);
  await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(filePath, 0o755);
}

async function initGitRepo(repoPath: string): Promise<void> {
  mkdirSync(repoPath, { recursive: true });
  await $`git -C ${repoPath} init -b main`.quiet();
  await $`git -C ${repoPath} config user.name Test`.quiet();
  await $`git -C ${repoPath} config user.email test@test`.quiet();
}

async function commitAll(repoPath: string, message: string): Promise<void> {
  await $`git -C ${repoPath} add -A`.quiet();
  await $`git -C ${repoPath} commit -m ${message} --allow-empty`.quiet().nothrow();
}

describe("new user E2E", () => {
  test("full journey: init todo repo → bootstrap settings → add task → claim → setup worktree", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workers-e2e-"));
    const workersRepoRoot = path.join(root, "workers");
    const todoRepoPath = path.join(root, "todo-repo");
    const targetProjectPath = path.join(root, "my-project");
    const binDir = path.join(root, "bin");
    const worktreeDir = path.join(root, "worktrees");

    // --- Step 1: Simulate workers repo with settings template ---
    mkdirSync(workersRepoRoot, { recursive: true });
    writeFileSync(
      path.join(workersRepoRoot, "settings.template.json"),
      '{ "model": "gpt-5.4" }\n',
      "utf8",
    );
    await createFakeCli(binDir, "claude");

    // --- Step 2: Bootstrap settings (first-time loadSettings) ---
    const settings = await loadSettings(workersRepoRoot, {
      env: { ...process.env, PATH: binDir },
    });

    expect(settings.defaultCli).toBe("claude");
    expect(settings.model).toBe("gpt-5.4");
    expect(existsSync(path.join(workersRepoRoot, "settings.json"))).toBe(true);

    // --- Step 3: Init shared TODO repo ---
    await initGitRepo(todoRepoPath);
    const templateContent = readFileSync(
      path.join(process.cwd(), "TODO.template.md"),
      "utf8",
    );
    writeFileSync(path.join(todoRepoPath, "TODO.md"), templateContent, "utf8");
    await commitAll(todoRepoPath, "Initialize shared TODO repo");

    // --- Step 4: Add a task to the ready section ---
    const todoPath = path.join(todoRepoPath, "TODO.md");
    const originalTodo = readFileSync(todoPath, "utf8");
    const taskLines = [
      "- Build a hello world CLI",
      `  - Type: New project`,
      `  - Repo: ${targetProjectPath}`,
      "  - Acceptance: Running the CLI prints 'Hello, world!'",
    ];
    const updatedTodo = insertIntoSection(originalTodo, taskLines, "ready");
    writeFileSync(todoPath, updatedTodo, "utf8");
    await commitAll(todoRepoPath, "Add first task");

    // Verify the task was added to the ready section
    const todoAfterAdd = readFileSync(todoPath, "utf8");
    expect(todoAfterAdd).toContain("## Ready to be picked up");
    expect(todoAfterAdd).toContain("- Build a hello world CLI");
    expect(todoAfterAdd).toContain(`  - Repo: ${targetProjectPath}`);

    // --- Step 5: Claim the task ---
    const claimResult = claimFromTodoText(todoAfterAdd, { agent: "claude" });

    expect(claimResult.status).toBe("claimed");
    expect(claimResult.item).toContain("Build a hello world CLI");
    expect(claimResult.itemType).toBe("new-project");

    // Verify the task moved to "In progress"
    expect(claimResult.updatedContent).toContain("## In progress");
    const inProgressMatch = claimResult.updatedContent.match(
      /## In progress\n\n([\s\S]*?)(?=\n##)/,
    );
    expect(inProgressMatch?.[1]).toContain("Build a hello world CLI");

    // Verify the task was removed from "Ready to be picked up"
    const readySection = claimResult.updatedContent
      .split("## Ready to be picked up")[1]
      ?.split(/\n##/)[0] ?? "";
    expect(readySection.trim()).toBe("");

    // --- Step 6: Resolve the target repo ---
    const target = resolveClaimedTaskTarget(
      claimResult.item,
      claimResult.itemType,
      todoRepoPath,
    );

    expect(target.repoPath).toBe(targetProjectPath);
    expect(target.itemType).toBe("new-project");
    expect(target.source).toBe("repo-field");

    // --- Step 7: Bootstrap the new project repo ---
    const ensured = await ensureTaskRepo(target);

    expect(ensured.bootstrapped).toBe(true);
    expect(ensured.repoRoot).toBe(targetProjectPath);
    expect(existsSync(path.join(targetProjectPath, ".git"))).toBe(true);

    // Verify the repo has an initial commit
    const logResult = await $`git -C ${targetProjectPath} log --oneline`.quiet();
    expect(logResult.stdout.trim()).toContain("initialize repository");

    // --- Step 8: Create a worktree for the worker ---
    const branchTarget = await resolveBranchTarget(targetProjectPath);
    const projectWorktreeDir = resolveProjectWorktreeDir(
      targetProjectPath,
      worktreeDir,
    );
    mkdirSync(projectWorktreeDir, { recursive: true });

    const worktreeLockRoot = path.join(
      targetProjectPath,
      ".git",
      "worktree-active-locks",
    );

    const { worktree } = await selectWorktree(
      targetProjectPath,
      {
        cli: "claude",
        worktreeDir,
        reuseWorktree: false,
        cleanup: false,
        cleanupStale: false,
        interactive: false,
        isolatedRuntime: false,
        setupOnly: false,
        noTodo: false,
        model: undefined,
        reasoningEffort: undefined,
        modelDefault: "gpt-5.4",
      },
      "claude-20260317-1-1",
      worktreeLockRoot,
      { projectName: "my-project" },
      branchTarget,
      projectWorktreeDir,
    );

    expect(worktree.reuseMode).toBe("new");
    expect(worktree.branchName).toBe("work/claude-20260317-1-1");
    expect(existsSync(worktree.path)).toBe(true);

    // Verify the worktree is on the correct branch
    const branchResult =
      await $`git -C ${worktree.path} branch --show-current`.quiet();
    expect(branchResult.stdout.trim()).toBe("work/claude-20260317-1-1");

    // --- Step 9: Verify task tracker resolution ---
    const resolvedTrackers = resolvePollingTaskTrackers(settings, {
      WORKERS_TODO_REPO: todoRepoPath,
    });
    expect(resolvedTrackers.length).toBe(1);
    expect(resolvedTrackers[0].tracker.kind).toBe("git-todo");
    expect(resolvedTrackers[0].source).toBe("default");

    // --- Cleanup worktree ---
    await $`git -C ${targetProjectPath} worktree remove --force ${worktree.path}`
      .quiet()
      .nothrow();
  });
});
