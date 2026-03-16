#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import readline from "readline/promises";
import { $ } from "zx";

const PLANNED_HEADER = "## Planned";

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function resolveGitRepoRoot(startPath: string): Promise<string> {
  const result =
    await $`git -C ${startPath} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Cannot find git repository for ${startPath}`);
  }
  return result.stdout.trim();
}

async function resolveSharedTodoPath(): Promise<string> {
  const todoRepoPath = readEnv("WORKERS_TODO_REPO");
  if (!todoRepoPath) {
    throw new Error("WORKERS_TODO_REPO is required.");
  }

  const todoFilePath = readEnv("WORKERS_TODO_FILE") ?? "TODO.md";
  const repoRoot = await resolveGitRepoRoot(path.resolve(process.cwd(), todoRepoPath));
  return path.resolve(repoRoot, todoFilePath);
}

async function readTodoText(argv: string[]): Promise<string> {
  const argText = argv.slice(2).join(" ").trim();
  if (argText) return argText;

  if (!process.stdin.isTTY) {
    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(String(chunk));
    }
    const stdinText = chunks.join("").trim();
    if (stdinText) return stdinText;
  }

  if (!process.stdout.isTTY) {
    throw new Error("TODO text is required.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("TODO text: ");
    const text = answer.trim();
    if (!text) {
      throw new Error("TODO text is required.");
    }
    return text;
  } finally {
    rl.close();
  }
}

function normalizeTodoItem(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""));

  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  if (lines.length === 0) {
    throw new Error("TODO text is required.");
  }

  if (!lines[0].startsWith("- ")) {
    lines[0] = `- ${lines[0]}`;
  }

  return lines;
}

function findSectionEnd(lines: string[], startIndex: number): number {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index]) || /^#\s+/.test(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

function insertIntoPlannedSection(content: string, itemLines: string[]): string {
  const lines = content.split(/\r?\n/);
  const plannedIndex = lines.findIndex((line) => line.trim() === PLANNED_HEADER);

  if (plannedIndex < 0) {
    const nextLines = lines.slice();
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
      nextLines.pop();
    }
    if (nextLines.length > 0) nextLines.push("");
    nextLines.push(PLANNED_HEADER, "", ...itemLines, "");
    return `${nextLines.join("\n")}\n`;
  }

  const plannedEnd = findSectionEnd(lines, plannedIndex);
  const nextLines = lines.slice();
  const insertion: string[] = [];

  if (plannedEnd > plannedIndex + 1 && nextLines[plannedEnd - 1] !== "") {
    insertion.push("");
  }
  insertion.push(...itemLines, "");

  nextLines.splice(plannedEnd, 0, ...insertion);
  return `${nextLines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const todoText = await readTodoText(process.argv);
  const todoPath = await resolveSharedTodoPath();
  const original = readFileSync(todoPath, "utf8");
  const nextContent = insertIntoPlannedSection(
    original,
    normalizeTodoItem(todoText),
  );
  writeFileSync(todoPath, nextContent, "utf8");
  console.log(`Added TODO to ${todoPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
