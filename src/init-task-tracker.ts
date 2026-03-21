import input from "@inquirer/input";
import select from "@inquirer/select";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { runGit } from "./git-cli.js";
import { determinePackageRoot } from "./settings.js";

async function ensureGitIdentity(repoDir: string): Promise<void> {
  const nameResult = await runGit(["-C", repoDir, "config", "--get", "user.name"]);
  if (nameResult.exitCode !== 0 || !nameResult.stdout.trim()) {
    await runGit(["-C", repoDir, "config", "user.name", "Workers"]);
  }

  const emailResult = await runGit(["-C", repoDir, "config", "--get", "user.email"]);
  if (emailResult.exitCode !== 0 || !emailResult.stdout.trim()) {
    await runGit([
      "-C",
      repoDir,
      "config",
      "user.email",
      "workers@example.invalid",
    ]);
  }
}

/**
 * Initialize a git-todo repository: creates the directory, initializes git if
 * needed, creates TODO.md from the template, and makes an initial commit.
 */
export async function initGitTodoRepo(repoDir: string): Promise<void> {
  mkdirSync(repoDir, { recursive: true });

  if (!existsSync(path.join(repoDir, ".git"))) {
    const result = await runGit(["-C", repoDir, "init"]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to initialize git repository in ${repoDir}.`);
    }
    process.stdout.write(`Initialized git repository in ${repoDir}.\n`);
  }

  const todoPath = path.join(repoDir, "TODO.md");
  if (!existsSync(todoPath)) {
    const templatePath = path.join(determinePackageRoot(), "todos-repo-template", "TODO.md");
    if (existsSync(templatePath)) {
      copyFileSync(templatePath, todoPath);
    } else {
      writeFileSync(
        todoPath,
        "# TODOs\n\n## In progress\n\n## Ready to be picked up\n\n## Planned\n",
        "utf8",
      );
    }
    process.stdout.write(`Created TODO.md in ${repoDir}.\n`);

    await ensureGitIdentity(repoDir);
    await runGit(["-C", repoDir, "add", "TODO.md"]);
    const commitResult =
      await runGit(["-C", repoDir, "commit", "-m", "Initialize TODO.md"]);
    if (commitResult.exitCode === 0) {
      process.stdout.write("Created initial commit.\n");
    }
  }
}

/**
 * Update the shell config file to set WORKERS_TODO_REPO, replacing any prior
 * value.  Defaults to ~/.bashrc; pass `shellConfigPath` to override for tests.
 */
export function updateShellConfig(
  repoDir: string,
  shellConfigPath = path.join(os.homedir(), ".bashrc"),
): void {
  let existing = "";
  if (existsSync(shellConfigPath)) {
    existing = readFileSync(shellConfigPath, "utf8");
  }

  const lines = existing
    .split("\n")
    .filter((line) => !line.startsWith("export WORKERS_TODO_REPO="));
  lines.push(`export WORKERS_TODO_REPO=${repoDir}`);

  const newContent = `${lines.join("\n").trimEnd()}\n`;
  writeFileSync(shellConfigPath, newContent, "utf8");
  process.stdout.write(`Updated ${shellConfigPath} with WORKERS_TODO_REPO=${repoDir}.\n`);
}

export interface InitTaskTrackerOptions {
  /** Override the tracker-type prompt (for testing). */
  promptForTrackerType?: () => Promise<"git-todo" | "github-issues">;
  /** Override the repo-directory prompt (for testing). */
  promptForRepoDir?: (defaultDir: string) => Promise<string>;
  /** Override the shell config path (for testing). */
  shellConfigPath?: string;
}

/**
 * Interactively prompt the user to set up a task tracker, then initialize it.
 * After this call returns, `process.env.WORKERS_TODO_REPO` is set for the
 * current session and `~/.bashrc` (or `shellConfigPath`) is updated.
 */
export async function promptAndInitTaskTracker(
  currentDir: string,
  options?: InitTaskTrackerOptions,
): Promise<void> {
  if (!options?.promptForTrackerType && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      "No task tracker is configured. Set WORKERS_TODO_REPO or configure a task tracker in settings.json.",
    );
  }

  const promptType =
    options?.promptForTrackerType ??
    (async () =>
      select<"git-todo" | "github-issues">({
        message: "No task tracker is configured. Which task tracker would you like to use?",
        choices: [
          { name: "git-todo (local git repository with TODO.md)", value: "git-todo" },
          { name: "GitHub Issues", value: "github-issues" },
        ],
      }));

  const trackerType = await promptType();
  if (trackerType !== "git-todo") {
    throw new Error(
      "GitHub Issues setup is not yet supported interactively. Configure it manually in settings.json.",
    );
  }

  const promptDir =
    options?.promptForRepoDir ??
    (async (defaultDir: string) =>
      input({
        message: "Where should the git-todo repository be initialized?",
        default: defaultDir,
      }));

  const rawDir = await promptDir(currentDir);
  const resolvedDir = path.resolve(rawDir.trim() || currentDir);

  await initGitTodoRepo(resolvedDir);
  updateShellConfig(resolvedDir, options?.shellConfigPath);

  process.env.WORKERS_TODO_REPO = resolvedDir;
  process.stdout.write(`Task tracker initialized. WORKERS_TODO_REPO=${resolvedDir}\n`);
}
