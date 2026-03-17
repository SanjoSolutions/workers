#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import readline from "readline/promises";
import { extractTodoField } from "./agent-prompt.js";
import { loadSettings, persistProjectSettings } from "./settings.js";
import { resolveTaskTrackerForTodoText } from "./task-tracker-settings.js";
import { createGitHubIssueTask } from "./task-trackers.js";

const SECTION_HEADERS = {
  planned: "## Planned",
  ready: "## Ready to be picked up",
} as const;

type TodoSection = keyof typeof SECTION_HEADERS;

function parseArgs(argv: string[]): { section: TodoSection; text: string } {
  let section: TodoSection = "planned";
  const textArgs: string[] = [];

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ready") {
      section = "ready";
      continue;
    }
    if (arg === "--planned") {
      section = "planned";
      continue;
    }
    if (arg === "--section") {
      const value = argv[index + 1]?.trim().toLowerCase();
      if (!value || !(value in SECTION_HEADERS)) {
        throw new Error(`--section must be one of: ${Object.keys(SECTION_HEADERS).join(", ")}`);
      }
      section = value as TodoSection;
      index += 1;
      continue;
    }
    textArgs.push(arg);
  }

  return {
    section,
    text: textArgs.join(" ").trim(),
  };
}

async function readTodoText(argText: string): Promise<string> {
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

export function insertIntoSection(
  content: string,
  itemLines: string[],
  section: TodoSection,
): string {
  const lines = content.split(/\r?\n/);
  const sectionHeader = SECTION_HEADERS[section];
  const plannedIndex = lines.findIndex((line) => line.trim() === sectionHeader);

  if (plannedIndex < 0) {
    const nextLines = lines.slice();
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
      nextLines.pop();
    }
    if (nextLines.length > 0) nextLines.push("");
    nextLines.push(sectionHeader, "", ...itemLines, "");
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
  const args = parseArgs(process.argv);
  const todoText = await readTodoText(args.text);
  const settings = await loadSettings();
  const repoField = extractTodoField(todoText, "Repo");
  if (repoField && repoField.toLowerCase() !== "none") {
    persistProjectSettings([
      {
        repo: path.resolve(repoField),
      },
    ]);
  }
  const tracker = resolveTaskTrackerForTodoText(todoText, settings);
  const itemLines = normalizeTodoItem(todoText);

  if (tracker.kind === "github-issues") {
    const issueUrl = await createGitHubIssueTask(tracker, args.section, itemLines);
    console.log(
      `Added TODO to ${args.section} in ${tracker.repository} as GitHub issue ${issueUrl} (task tracker: ${tracker.name})`,
    );
    return;
  }

  const todoPath = path.resolve(tracker.repo, tracker.file);
  const original = readFileSync(todoPath, "utf8");
  const nextContent = insertIntoSection(
    original,
    itemLines,
    args.section,
  );
  writeFileSync(todoPath, nextContent, "utf8");
  console.log(
    `Added TODO to ${args.section} in ${todoPath} (task tracker: ${tracker.name})`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
