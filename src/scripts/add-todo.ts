#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import readline from "readline/promises";
import { SECTION_HEADERS, type TodoSection } from "../add-todo.js";
import { addTodoToConfiguredTracker } from "../add-todo-command.js";

interface ParsedArgs {
  section: TodoSection;
  text: string;
  issueNumber: number | undefined;
}

function printUsage(): void {
  console.log(`Usage: add-todo.js [options] [text...]

Add an item to the configured task tracker.

Options:
  --ready             Add to the "Ready to be picked up" section
  --planned           Add to the "Planned" section (default)
  --section <name>    Add to a specific section by name
  --issue <number>    Update an existing GitHub issue by number
  -h, --help          Print this help message and exit

Arguments:
  text                Item text (reads from stdin if omitted)`);
}

function parseArgs(argv: string[]): ParsedArgs {
  let section: TodoSection = "planned";
  let issueNumber: number | undefined;
  const textArgs: string[] = [];

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
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
        throw new Error(
          `--section must be one of: ${Object.keys(SECTION_HEADERS).join(", ")}`,
        );
      }
      section = value as TodoSection;
      index += 1;
      continue;
    }
    if (arg === "--issue") {
      const value = argv[index + 1]?.trim();
      if (!value || Number.isNaN(Number(value))) {
        throw new Error("--issue requires a numeric issue number.");
      }
      issueNumber = Number(value);
      index += 1;
      continue;
    }

    textArgs.push(arg);
  }

  return {
    section,
    text: textArgs.join(" ").trim(),
    issueNumber,
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
    throw new Error("Item text is required.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("Item text: ");
    const text = answer.trim();
    if (!text) {
      throw new Error("Item text is required.");
    }
    return text;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const todoText = await readTodoText(args.text);
  const message = await addTodoToConfiguredTracker({
    section: args.section,
    text: todoText,
    issueNumber: args.issueNumber,
    cwd: process.cwd(),
  });
  console.log(message);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
