import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { $ } from "zx";
import { describe, expect, test } from "vitest";

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

function runWorker(
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const workerScript = path.join(process.cwd(), "src/bin/worker.ts");
  return $({ env, nothrow: true, quiet: true })`npx tsx ${workerScript} ${args}`;
}

describe("new user E2E", () => {
  test("full journey: init todo repo → add task → worker claims and sets up worktree", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workers-e2e-"));
    const configDir = path.join(root, "config");
    const todoRepoPath = path.join(root, "todo-repo");
    const targetProjectPath = path.join(root, "my-project");
    const binDir = path.join(root, "bin");
    const worktreeDir = path.join(root, "worktrees");

    // --- Step 1: Set up config dir with settings ---
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        worker: { defaults: { cli: "claude", model: "gpt-5.4" } },
        taskTrackers: {
          default: { repo: todoRepoPath },
        },
        defaultTaskTracker: "default",
      }, null, 2) + "\n",
      "utf8",
    );
    await createFakeCli(binDir, "claude");

    // --- Step 2: Init shared TODO repo with a task in the ready section ---
    await initGitRepo(todoRepoPath);
    const templateContent = readFileSync(
      path.join(process.cwd(), "TODO.template.md"),
      "utf8",
    );
    const taskLines = [
      "- Build a hello world CLI",
      "  - Type: New project",
      `  - Repo: ${targetProjectPath}`,
      "  - Acceptance: Running the CLI prints 'Hello, world!'",
    ].join("\n");
    const todoContent = templateContent.replace(
      "## Ready to be picked up\n",
      `## Ready to be picked up\n\n${taskLines}\n`,
    );
    writeFileSync(path.join(todoRepoPath, "TODO.md"), todoContent, "utf8");
    await commitAll(todoRepoPath, "Add first task");

    // --- Step 3: Run `worker --setup-only` to claim the task and set up the worktree ---
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKERS_CONFIG_DIR: configDir,
      WORKERS_TODO_REPO: "",
      PATH: `${binDir}:${process.env.PATH}`,
    };

    const result = await runWorker(env, [
      "--cli", "claude",
      "--setup-only",
      "--fresh-worktree",
      "--worktree-dir", worktreeDir,
      "--no-isolated-runtime",
    ]);

    expect(result.exitCode, `worker stderr: ${result.stderr}`).toBe(0);
    const output = result.stdout + result.stderr;

    // --- Step 4: Verify the task was claimed (moved from Ready to In progress) ---
    const todoAfterClaim = readFileSync(path.join(todoRepoPath, "TODO.md"), "utf8");
    const inProgressSection = todoAfterClaim
      .split("## In progress")[1]
      ?.split(/\n##/)[0] ?? "";
    expect(inProgressSection).toContain("Build a hello world CLI");

    const readySection = todoAfterClaim
      .split("## Ready to be picked up")[1]
      ?.split(/\n##/)[0] ?? "";
    expect(readySection.trim()).toBe("");

    // --- Step 5: Verify the target project repo was bootstrapped ---
    expect(existsSync(path.join(targetProjectPath, ".git"))).toBe(true);
    const logResult = await $`git -C ${targetProjectPath} log --oneline`.quiet();
    expect(logResult.stdout.trim()).toContain("initialize repository");

    // --- Step 6: Verify a worktree was created ---
    const worktreeListResult =
      await $`git -C ${targetProjectPath} worktree list --porcelain`.quiet();
    const worktreeLines = worktreeListResult.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    // At least 2: the main repo + the worker worktree
    expect(worktreeLines.length).toBeGreaterThanOrEqual(2);

    const workerWorktreeLine = worktreeLines.find(
      (line) => !line.includes(targetProjectPath + "\n") && line !== `worktree ${targetProjectPath}`,
    );
    expect(workerWorktreeLine).toBeDefined();
    const workerWorktreePath = workerWorktreeLine!.replace("worktree ", "");
    expect(existsSync(workerWorktreePath)).toBe(true);

    // Verify the worktree is on a work/ branch
    const branchResult =
      await $`git -C ${workerWorktreePath} branch --show-current`.quiet();
    expect(branchResult.stdout.trim()).toMatch(/^work\//);

    // --- Step 7: Verify output contains expected log messages ---
    expect(output).toContain("Claiming TODO");
    expect(output).toContain("Build a hello world CLI");
    expect(output).toContain("Setup complete");

    // --- Cleanup ---
    await $`git -C ${targetProjectPath} worktree remove --force ${workerWorktreePath}`
      .quiet()
      .nothrow();
  });
});
