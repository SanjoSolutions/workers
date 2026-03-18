import { spawn } from "child_process";
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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

interface InteractiveStep {
  waitFor: string;
  send: string;
}

/**
 * Run a command inside a PTY (via `unbuffer -p`) so @inquirer/select prompts
 * see a real terminal. Steps are triggered when `waitFor` text appears in the
 * output, sending `send` to stdin.
 */
function runInteractive(
  script: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  steps: InteractiveStep[],
  timeoutSeconds = 15,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), script);
    const child = spawn(
      "unbuffer",
      ["-p", "timeout", String(timeoutSeconds), "npx", "tsx", scriptPath, ...args],
      { env: { ...env, NO_COLOR: "1", TERM: "dumb" } },
    );

    let output = "";
    let stepIndex = 0;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutSeconds}s. Output:\n${stripAnsi(output)}`));
    }, (timeoutSeconds + 5) * 1000);

    const checkTriggers = () => {
      const clean = stripAnsi(output);
      while (stepIndex < steps.length) {
        if (clean.includes(steps[stepIndex].waitFor)) {
          child.stdin.write(steps[stepIndex].send);
          stepIndex++;
        } else {
          break;
        }
      }
    };

    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      checkTriggers();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
      checkTriggers();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: stripAnsi(output) });
    });
  });
}

describe("new user E2E", () => {
  test("full journey: assistant bootstraps → add task → worker claims and runs", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "workers-e2e-"));
    const configDir = path.join(root, "config");
    const todoRepoPath = path.join(root, "todo-repo");
    const targetProjectPath = path.join(root, "my-project");
    const binDir = path.join(root, "bin");
    const worktreeDir = path.join(root, "worktrees");

    await createFakeCli(binDir, "claude");
    await createFakeCli(binDir, "codex");

    // Init the shared TODO repo ahead of time (assistant just stores the path)
    await initGitRepo(todoRepoPath);
    const templateContent = readFileSync(
      path.join(process.cwd(), "TODO.template.md"),
      "utf8",
    );
    writeFileSync(path.join(todoRepoPath, "TODO.md"), templateContent, "utf8");
    await commitAll(todoRepoPath, "Initial TODO");

    // Pre-configure settings with a project and task tracker
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        projects: [
          {
            repo: targetProjectPath,
            taskTracker: { repo: todoRepoPath, file: "TODO.md" },
          },
        ],
      }, null, 2),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKERS_CONFIG_DIR: configDir,
      WORKERS_TODO_REPO: "",
      PATH: `${binDir}:${process.env.PATH}`,
    };

    // --- Step 1: Run `assistant` — prompts for CLI selection ---
    const assistantResult = await runInteractive(
      "src/bin/assistant.ts",
      env,
      [],
      [
        { waitFor: "Choose the default assistant CLI", send: "\r" },       // Enter → select claude (first option)
      ],
    );

    expect(assistantResult.exitCode, `assistant output: ${assistantResult.output}`).toBe(0);
    expect(existsSync(path.join(configDir, "settings.json"))).toBe(true);

    // Verify settings were persisted correctly
    const settings = JSON.parse(readFileSync(path.join(configDir, "settings.json"), "utf8"));
    expect(settings.assistant?.defaults?.cli).toBe("claude");

    // --- Step 2: Add a task to the shared TODO repo ---
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

    // --- Step 3: Run `worker` — prompts for CLI selection, then claims and runs ---
    const workerResult = await runInteractive(
      "src/bin/worker.ts",
      env,
      ["--worktree-dir", worktreeDir],
      [
        { waitFor: "Choose the default worker CLI", send: "\r" },           // Enter → select claude (first option)
      ],
      30,
    );

    const workerOutput = workerResult.output;

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

    // --- Step 5b: Verify SPEC.md and AGENTS.md were initialized ---
    expect(existsSync(path.join(targetProjectPath, "SPEC.md"))).toBe(true);
    expect(existsSync(path.join(targetProjectPath, "AGENTS.md"))).toBe(true);

    // Verify they match the templates
    const specContent = readFileSync(path.join(targetProjectPath, "SPEC.md"), "utf8");
    const specTemplate = readFileSync(path.join(process.cwd(), "new-project-template", "SPEC.md"), "utf8");
    expect(specContent).toBe(specTemplate);

    const agentsContent = readFileSync(path.join(targetProjectPath, "AGENTS.md"), "utf8");
    const agentsTemplate = readFileSync(path.join(process.cwd(), "new-project-template", "AGENTS.md"), "utf8");
    expect(agentsContent).toBe(agentsTemplate);

    // --- Step 6: Verify a worktree was created ---
    const worktreeListResult =
      await $`git -C ${targetProjectPath} worktree list --porcelain`.quiet();
    const worktreeLines = worktreeListResult.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
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
    expect(workerOutput).toContain("Claiming TODO");
    expect(workerOutput).toContain("Build a hello world CLI");
    expect(workerOutput).toContain("Created SPEC.md");
    expect(workerOutput).toContain("Created AGENTS.md");
    expect(workerOutput).toContain("Finished");

    // Verify worker persisted its CLI choice
    const updatedSettings = JSON.parse(readFileSync(path.join(configDir, "settings.json"), "utf8"));
    expect(updatedSettings.worker?.defaults?.cli).toBe("claude");

    // --- Cleanup ---
    await $`git -C ${targetProjectPath} worktree remove --force ${workerWorktreePath}`
      .quiet()
      .nothrow();
  });
});
