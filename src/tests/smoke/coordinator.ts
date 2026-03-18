/**
 * Smoke test: verify the coordinator skill is picked up by Claude CLI.
 *
 * Requires a real `claude` binary authenticated via ~/.claude/.credentials.json.
 *
 * Sets up a project with the coordinator skill, launches Claude
 * interactively, sends a large multi-step request, and lets you observe
 * whether it delegates to TODO.md or starts implementing directly.
 * Stop with Ctrl+C once it's clear whether it worked.
 */

import { spawn } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { $ } from "zx";

const TODO_TEMPLATE = readFileSync(
  path.join(process.cwd(), "TODO.template.md"),
  "utf8",
);

async function setupProject(root: string, name: string): Promise<string> {
  const projectPath = path.join(root, name);

  mkdirSync(projectPath, { recursive: true });
  await $`git -C ${projectPath} init -b main`.quiet();
  await $`git -C ${projectPath} config user.name Test`.quiet();
  await $`git -C ${projectPath} config user.email test@test`.quiet();

  // TODO.md from template
  writeFileSync(path.join(projectPath, "TODO.md"), TODO_TEMPLATE);

  // Provide add-todo.js at build/scripts/add-todo.js — matching the path
  // referenced in the coordinator skill — so Claude can queue tasks.
  const addTodoDir = path.join(projectPath, "build", "scripts");
  mkdirSync(addTodoDir, { recursive: true });
  writeFileSync(
    path.join(addTodoDir, "add-todo.js"),
    [
      'const { readFileSync, writeFileSync } = require("fs");',
      'const path = require("path");',
      "",
      "const args = process.argv.slice(2);",
      'const section = args.includes("--ready") ? "## Ready to be picked up" : "## Planned";',
      'const todoFile = path.join(__dirname, "..", "..", "TODO.md");',
      "",
      "const chunks = [];",
      'process.stdin.on("data", (chunk) => chunks.push(chunk));',
      'process.stdin.on("end", () => {',
      '  const input = Buffer.concat(chunks).toString().trim();',
      "  if (!input) { process.exit(1); }",
      '  const content = readFileSync(todoFile, "utf8");',
      "  const updated = content.replace(section, section + \"\\n\\n\" + input);",
      '  writeFileSync(todoFile, updated, "utf8");',
      "  console.log(`Added TODO to ${section} in ${todoFile}`);",
      "});",
      "",
    ].join("\n"),
  );

  // Initial commit
  await $`git -C ${projectPath} add -A`.quiet();
  await $`git -C ${projectPath} commit -m "initialize repository"`.quiet();

  return projectPath;
}

const PROMPT = [
  "Build a full REST API with the following:",
  "- User authentication with OAuth2 and JWT tokens",
  "- Role-based access control (admin, editor, viewer)",
  "- CRUD endpoints for users, posts, and comments",
  "- Rate limiting and request validation",
  "- PostgreSQL database with migrations",
  "- Comprehensive test suite with integration tests",
  "- OpenAPI documentation",
].join("\n");

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "smoke-coordinator-"));
  const projectPath = await setupProject(root, "big-task");

  console.log(`Project: ${projectPath}\n`);
  console.log("Launching Claude interactively with a big task.");
  console.log("Watch the output — stop with Ctrl+C once it's clear whether the");
  console.log("coordinator delegated to TODO.md or started implementing directly.\n");

  const workersRoot = process.cwd();
  const assistantSystemPath = path.join(workersRoot, "ASSISTANT_SYSTEM.md");
  const assistantAgentDir = path.join(workersRoot, "agents", "assistant");

  const child = spawn(
    "claude",
    [
      "--dangerously-skip-permissions",
      "--append-system-prompt-file",
      assistantSystemPath,
      "--add-dir",
      assistantAgentDir,
      "--",
      PROMPT,
    ],
    {
      cwd: projectPath,
      stdio: "inherit",
      env: process.env,
    },
  );

  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });

  await new Promise<void>((resolve) => {
    child.on("close", () => {
      resolve();
    });
  });

  // Print TODO.md so you can check if it was modified
  const todoAfter = readFileSync(
    path.join(projectPath, "TODO.md"),
    "utf8",
  );
  if (todoAfter === TODO_TEMPLATE) {
    console.log("\nTODO.md: unchanged (coordinator did NOT delegate)");
  } else {
    console.log("\nTODO.md after:");
    console.log(todoAfter);
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
