import { spawnSync, type SpawnSyncOptions } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

interface FakeCliInvocation {
  argv: string[];
  cwd: string;
  env: {
    WORK_MODE?: string;
    WORK_PRECLAIMED_TODO?: string;
  };
}

interface PackagedSettingsFile {
  worker?: {
    defaults?: {
      cli?: string;
    };
  };
  assistant?: {
    defaults?: {
      cli?: string;
    };
  };
}

function runCommandOrThrow(
  command: string,
  args: string[],
  options: SpawnSyncOptions = {},
): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });

  if (result.status === 0) {
    return result.stdout ?? "";
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  throw new Error(
    [`Command failed: ${command} ${args.join(" ")}`, output].filter(Boolean).join("\n"),
  );
}

function createGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true });
  runCommandOrThrow("git", ["init", "-b", "main"], { cwd: repoPath });
  runCommandOrThrow("git", ["config", "user.name", "Test"], { cwd: repoPath });
  runCommandOrThrow("git", ["config", "user.email", "test@test"], { cwd: repoPath });
  runCommandOrThrow("git", ["commit", "--allow-empty", "-m", "initialize repository"], { cwd: repoPath });
}

function createFakeClaude(binDir: string, logDir: string): void {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const runnerPath = path.join(binDir, "claude-runner.cjs");
  writeFileSync(
    runnerPath,
    [
      'const fs = require("fs");',
      'const path = require("path");',
      'const logDir = process.env.WORKERS_FAKE_CLI_LOG_DIR;',
      'if (!logDir) throw new Error("WORKERS_FAKE_CLI_LOG_DIR is required.");',
      "fs.mkdirSync(logDir, { recursive: true });",
      "const payload = {",
      "  argv: process.argv.slice(2),",
      "  cwd: process.cwd(),",
      "  env: {",
      "    WORK_MODE: process.env.WORK_MODE,",
      "    WORK_PRECLAIMED_TODO: process.env.WORK_PRECLAIMED_TODO,",
      "  },",
      "};",
      'const logPath = path.join(logDir, `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);',
      "fs.writeFileSync(logPath, JSON.stringify(payload, null, 2));",
      'process.stdout.write("FAKE_CLAUDE_OK\\n");',
    ].join("\n"),
    "utf8",
  );

  if (process.platform === "win32") {
    writeFileSync(
      path.join(binDir, "claude.cmd"),
      `@echo off\r\n"${process.execPath}" "${runnerPath}" %*\r\n`,
      "utf8",
    );
    return;
  }

  const commandPath = path.join(binDir, "claude");
  writeFileSync(
    commandPath,
    `#!/bin/sh\nexec "${process.execPath}" "${runnerPath}" "$@"\n`,
    "utf8",
  );
  chmodSync(commandPath, 0o755);
}

function readFakeCliInvocations(logDir: string): FakeCliInvocation[] {
  return readdirSync(logDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) =>
      JSON.parse(readFileSync(path.join(logDir, entry), "utf8")) as FakeCliInvocation
    );
}

function resolveGitBinaryDir(): string {
  const command = process.platform === "win32" ? "where" : "which";
  const gitPath = runCommandOrThrow(command, ["git"]).trim().split(/\r?\n/, 1)[0];
  if (!gitPath) {
    throw new Error("Failed to resolve the git executable for the packaged smoke test.");
  }
  return path.dirname(gitPath);
}

function normalizeExistingPath(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath);
  if (!existsSync(resolvedPath)) {
    return resolvedPath;
  }
  return realpathSync.native(resolvedPath);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "workers-packaged-smoke-"));
  const fakeBinDir = path.join(tempRoot, "fake-bin");
  const fakeLogDir = path.join(tempRoot, "fake-cli-logs");
  const configDir = path.join(tempRoot, "config");
  const packDir = path.join(tempRoot, "pack");
  const installDir = path.join(tempRoot, "install");
  const assistantRepo = path.join(tempRoot, "assistant-repo");
  const todoRepo = path.join(tempRoot, "todo-repo");
  const workerRepo = path.join(tempRoot, "worker-repo");
  const worktreeDir = path.join(tempRoot, "worktrees");

  createFakeClaude(fakeBinDir, fakeLogDir);
  createGitRepo(assistantRepo);
  createGitRepo(workerRepo);
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

  runCommandOrThrow("npm", ["pack", "--pack-destination", packDir], { cwd: repoRoot });
  const tarballName = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error("Failed to create a package tarball for smoke testing.");
  }

  writeFileSync(
    path.join(installDir, "package.json"),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
    "utf8",
  );
  runCommandOrThrow("npm", ["install", path.join(packDir, tarballName)], { cwd: installDir });

  const installedPackageRoot = path.join(installDir, "node_modules", "@sanjo", "workers");
  const assistantEntrypoint = path.join(installedPackageRoot, "build", "bin", "assistant.js");
  const workerEntrypoint = path.join(installedPackageRoot, "build", "bin", "worker.js");
  const settingsTemplatePath = path.join(installedPackageRoot, "settings.template.json");
  const todoTemplatePath = path.join(installedPackageRoot, "todos-repo-template", "TODO.md");

  if (!existsSync(assistantEntrypoint) || !existsSync(workerEntrypoint)) {
    throw new Error("Installed package is missing the packaged assistant or worker entrypoint.");
  }
  if (!existsSync(settingsTemplatePath)) {
    throw new Error("Installed package is missing settings.template.json.");
  }
  if (!existsSync(todoTemplatePath)) {
    throw new Error("Installed package is missing todos-repo-template/TODO.md.");
  }

  const { initGitTodoRepo } = await import(
    pathToFileURL(path.join(installedPackageRoot, "build", "init-task-tracker.js")).href
  );
  await initGitTodoRepo(todoRepo);

  const initializedTodo = readFileSync(path.join(todoRepo, "TODO.md"), "utf8");
  const packagedTodoTemplate = readFileSync(todoTemplatePath, "utf8");
  if (initializedTodo !== packagedTodoTemplate) {
    throw new Error("Installed package did not initialize TODO.md from the packaged TODO repo template.");
  }

  const {
    WORK_MODE: _ignoredWorkMode,
    WORK_PRECLAIMED_TODO: _ignoredPreclaimedTodo,
    WORK_PRECLAIMED_TODO_TYPE: _ignoredPreclaimedTodoType,
    ...baseEnv
  } = process.env;

  const sharedEnv = {
    ...baseEnv,
    PATH: `${fakeBinDir}${path.delimiter}${resolveGitBinaryDir()}`,
    WORKERS_CONFIG_DIR: configDir,
    WORKERS_FAKE_CLI_LOG_DIR: fakeLogDir,
  };

  runCommandOrThrow(process.execPath, [assistantEntrypoint], {
    cwd: assistantRepo,
    env: sharedEnv,
  });
  runCommandOrThrow(process.execPath, [workerEntrypoint, "--no-todo", "--cleanup", "--worktree-dir", worktreeDir], {
    cwd: workerRepo,
    env: sharedEnv,
  });

  const settings = JSON.parse(
    readFileSync(path.join(configDir, "settings.json"), "utf8"),
  ) as PackagedSettingsFile;
  if (settings.assistant?.defaults?.cli !== "claude") {
    throw new Error("Packaged assistant entrypoint did not bootstrap assistant CLI settings.");
  }
  if (settings.worker?.defaults?.cli !== "claude") {
    throw new Error("Packaged worker entrypoint did not bootstrap worker CLI settings.");
  }

  const invocations = readFakeCliInvocations(fakeLogDir);
  if (invocations.length !== 2) {
    throw new Error(`Expected 2 fake CLI invocations, received ${invocations.length}.`);
  }

  const assistantInvocation = invocations.find((entry) => entry.env.WORK_MODE === undefined);
  const workerInvocation = invocations.find((entry) => entry.env.WORK_MODE === "interactive");

  if (!assistantInvocation) {
    throw new Error("Packaged assistant entrypoint did not launch the fake Claude CLI.");
  }
  if (!workerInvocation) {
    throw new Error("Packaged worker entrypoint did not launch the fake Claude CLI.");
  }
  if (normalizeExistingPath(assistantInvocation.cwd) !== normalizeExistingPath(assistantRepo)) {
    throw new Error("Packaged assistant entrypoint did not launch from the project directory.");
  }
  if (normalizeExistingPath(workerInvocation.cwd) === normalizeExistingPath(workerRepo)) {
    throw new Error("Packaged worker entrypoint did not launch from its isolated worktree.");
  }
  if (!assistantInvocation.argv.includes("--append-system-prompt-file")) {
    throw new Error("Packaged assistant entrypoint did not pass the assistant system prompt.");
  }
  if (!workerInvocation.argv.includes("--append-system-prompt-file")) {
    throw new Error("Packaged worker entrypoint did not pass a system prompt file.");
  }

  console.log("Packaged assistant and worker smoke test passed.");
}

main().catch((error) => {
  console.error("Packaged entrypoint smoke test failed:", error);
  process.exit(1);
});
