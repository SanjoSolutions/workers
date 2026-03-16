#!/usr/bin/env tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import readline from "readline/promises";
import { fileURLToPath } from "url";
import { $ } from "zx";

async function promptTargetRepo(argv: string[]): Promise<string> {
  const suggestedPath = path.resolve(
    process.cwd(),
    argv[2]?.trim() || process.env.WORKERS_TODO_REPO?.trim() || ".",
  );

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return suggestedPath;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `Initialize shared TODO repo in [${suggestedPath}]: `,
    );
    const target = answer.trim() || suggestedPath;
    return path.resolve(process.cwd(), target);
  } finally {
    rl.close();
  }
}

async function ensureGitRepo(repoPath: string): Promise<void> {
  mkdirSync(repoPath, { recursive: true });

  const gitDir = path.join(repoPath, ".git");
  if (existsSync(gitDir)) return;

  const initResult =
    await $`git -C ${repoPath} init -b main`.quiet().nothrow();
  if (initResult.exitCode === 0) return;

  const fallbackInit =
    await $`git -C ${repoPath} init`.quiet().nothrow();
  if (fallbackInit.exitCode !== 0) {
    throw new Error(`Failed to initialize git repo at ${repoPath}`);
  }
  await $`git -C ${repoPath} checkout -b main`.quiet().nothrow();
}

async function ensureInitialCommit(repoPath: string, createdTodo: boolean): Promise<void> {
  if (!createdTodo) return;

  const hasCommits =
    await $`git -C ${repoPath} rev-parse --verify HEAD`.quiet().nothrow();
  await $`git -C ${repoPath} add TODO.md`.quiet().nothrow();

  if (hasCommits.exitCode === 0) {
    const stagedDiff =
      await $`git -C ${repoPath} diff --cached --quiet -- TODO.md`.quiet().nothrow();
    if (stagedDiff.exitCode === 0) return;
  }

  const commitResult =
    await $`git -C ${repoPath} commit -m ${"Initialize shared TODO repo"}`
      .quiet()
      .nothrow();
  if (commitResult.exitCode !== 0) {
    throw new Error(`Failed to create initial commit in ${repoPath}`);
  }
}

function resolveBashrcPath(): string {
  const overridePath = process.env.WORKERS_BASHRC_PATH?.trim();
  if (overridePath) {
    return path.resolve(process.cwd(), overridePath);
  }
  const homeDir = process.env.HOME;
  if (!homeDir) {
    throw new Error("HOME is not set, cannot locate ~/.bashrc");
  }
  return path.join(homeDir, ".bashrc");
}

function ensureBashrcExport(repoPath: string): string {
  const bashrcPath = resolveBashrcPath();
  const exportLine = `export WORKERS_TODO_REPO=${repoPath}`;

  let content = "";
  if (existsSync(bashrcPath)) {
    content = readFileSync(bashrcPath, "utf8");
  } else {
    mkdirSync(path.dirname(bashrcPath), { recursive: true });
  }

  const lines = content === "" ? [] : content.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^\s*export\s+WORKERS_TODO_REPO=/.test(line)) {
      replaced = true;
      return exportLine;
    }
    return line;
  });

  if (!replaced) {
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
      nextLines.pop();
    }
    if (nextLines.length > 0) nextLines.push("");
    nextLines.push(exportLine);
  }

  writeFileSync(bashrcPath, `${nextLines.join("\n")}\n`, "utf8");
  return bashrcPath;
}

async function main(): Promise<void> {
  const repoPath = await promptTargetRepo(process.argv);
  const currentFile = fileURLToPath(import.meta.url);
  const templatePath = path.resolve(path.dirname(currentFile), "..", "TODO.template.md");
  const todoPath = path.join(repoPath, "TODO.md");

  await ensureGitRepo(repoPath);

  let createdTodo = false;
  if (!existsSync(todoPath)) {
    const template = readFileSync(templatePath, "utf8");
    writeFileSync(todoPath, template, "utf8");
    createdTodo = true;
  }

  await ensureInitialCommit(repoPath, createdTodo);
  const bashrcPath = ensureBashrcExport(repoPath);

  console.log(`Shared TODO repo ready: ${repoPath}`);
  console.log(`TODO file: ${todoPath}`);
  console.log(`Updated WORKERS_TODO_REPO in: ${bashrcPath}`);
  console.log("Run: source ~/.bashrc");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
