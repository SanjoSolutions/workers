/**
 * Smoke test: verify the assistant guidance is picked up by Claude CLI.
 *
 * Requires a real `claude` binary authenticated via ~/.claude/.credentials.json.
 *
 * Sets up a project with the assistant guidance, launches Claude
 * interactively, sends a large multi-step request, and lets you observe
 * whether it delegates to TODO.md or starts implementing directly.
 * Stop with Ctrl+C once it's clear whether it worked.
 */

import { spawn } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { $ } from "zx";
import { prepareSystemPrompt } from "../../assistant-system-prompt.js";

const TODO_TEMPLATE = readFileSync(
  path.join(process.cwd(), "todos-repo-template", "TODO.md"),
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

  // Provide a fake `o` command matching the assistant instructions so Claude
  // can queue tasks in the local TODO file during the smoke test.
  const fakeBinDir = path.join(projectPath, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(
    path.join(fakeBinDir, "o"),
    [
      "#!/usr/bin/env node",
      'const { readFileSync, writeFileSync } = require("fs");',
      'const path = require("path");',
      "",
      "const args = process.argv.slice(2);",
      'const command = args[0];',
      'const todoFile = path.join(process.cwd(), "TODO.md");',
      "",
      'if (command === "status") {',
      '  console.log(readFileSync(todoFile, "utf8"));',
      "  process.exit(0);",
      "}",
      "",
      'if (command !== "add") {',
      '  console.error(`Unsupported command: ${command}`);',
      "  process.exit(1);",
      "}",
      "",
      'const section = args.includes("--ready") ? "## Ready to be picked up" : "## Planned";',
      "const chunks = [];",
      'process.stdin.on("data", (chunk) => chunks.push(chunk));',
      'process.stdin.on("end", () => {',
      '  const input = Buffer.concat(chunks).toString().trim() || args[args.length - 1]?.trim();',
      "  if (!input || input === command || input === '--ready') { process.exit(1); }",
      '  const content = readFileSync(todoFile, "utf8");',
      "  const updated = content.replace(section, section + \"\\n\\n\" + input);",
      '  writeFileSync(todoFile, updated, "utf8");',
      "  console.log(`Added item to ${section} in ${todoFile}`);",
      "});",
    ].join("\n"),
  );
  chmodSync(path.join(fakeBinDir, "o"), 0o755);

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
  const root = mkdtempSync(path.join(tmpdir(), "smoke-assistant-"));
  const projectPath = await setupProject(root, "big-task");

  console.log(`Project: ${projectPath}\n`);
  console.log("Launching Claude interactively with a big task.");
  console.log("Watch the output — stop with Ctrl+C once it's clear whether the");
  console.log("assistant queued work in TODO.md or started implementing directly.\n");

  const workersRoot = process.cwd();
  const assistantAgentDir = path.join(workersRoot, "agents", "assistant");
  const preparedAssistantSystemPrompt = prepareSystemPrompt(
    path.join(assistantAgentDir, "SYSTEM.md"),
    "claude",
  );

  const child = spawn(
    "claude",
    [
      "--dangerously-skip-permissions",
      "--append-system-prompt-file",
      preparedAssistantSystemPrompt.filePath,
      "--add-dir",
      assistantAgentDir,
      "--",
      PROMPT,
    ],
    {
      cwd: projectPath,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      },
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
  preparedAssistantSystemPrompt.cleanup();

  // Print TODO.md so you can check if it was modified
  const todoAfter = readFileSync(
    path.join(projectPath, "TODO.md"),
    "utf8",
  );
  if (todoAfter === TODO_TEMPLATE) {
    console.log("\nTODO.md: unchanged (assistant did NOT queue the work)");
  } else {
    console.log("\nTODO.md after:");
    console.log(todoAfter);
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
