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

  console.log(`Shared TODO repo ready: ${repoPath}`);
  console.log(`TODO file: ${todoPath}`);
  if (!process.env.WORKERS_TODO_REPO?.trim()) {
    console.log(`Export this in your shell: export WORKERS_TODO_REPO=${repoPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
