/**
 * Smoke test: verify the worker skill is picked up by Claude CLI.
 *
 * Requires a real `claude` binary authenticated via ~/.claude/.credentials.json.
 *
 * Claude receives system instructions via --append-system-prompt-file and loads
 * skills from the agent directory via --add-dir. We send a simple prompt and
 * verify the output contains evidence that the instructions were loaded.
 */

import { spawnSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { $ } from "zx";
import { prepareSystemPrompt } from "../../assistant-system-prompt.js";

async function setupProject(root: string, name: string): Promise<string> {
  const projectPath = path.join(root, name);

  mkdirSync(projectPath, { recursive: true });
  await $`git -C ${projectPath} init -b main`.quiet();
  await $`git -C ${projectPath} config user.name Test`.quiet();
  await $`git -C ${projectPath} config user.email test@test`.quiet();

  await $`git -C ${projectPath} commit --allow-empty -m "initialize repository"`.quiet();

  return projectPath;
}

const PROMPT =
  "Reply with exactly the text: SYSTEM_INSTRUCTIONS_LOADED. Do not add any other text.";

const EXPECTED = "SYSTEM_INSTRUCTIONS_LOADED";

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "smoke-claude-"));
  const projectPath = await setupProject(root, "claude-test");

  console.log(`Project: ${projectPath}\n`);
  console.log("Launching Claude with a simple verification prompt...\n");

  const workersRoot = process.cwd();
  const workerAgentDir = path.join(workersRoot, "agents", "worker");
  const preparedSystemPrompt = prepareSystemPrompt(
    path.join(workerAgentDir, "SYSTEM.md"),
    "claude",
  );

  const result = spawnSync(
    "claude",
    [
      "--dangerously-skip-permissions",
      "--append-system-prompt-file",
      preparedSystemPrompt.filePath,
      "--add-dir",
      workerAgentDir,
      "-p",
      PROMPT,
    ],
    {
      cwd: projectPath,
      encoding: "utf8",
      env: process.env,
      timeout: 120_000,
    },
  );

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  console.log("Claude output:");
  console.log(output);

  if (result.status !== 0) {
    console.error(`\nClaude exited with status ${result.status}`);
    process.exit(1);
  }

  if (output.includes(EXPECTED)) {
    console.log("\nSmoke test passed: Claude responded as expected.");
  } else {
    console.error(
      `\nSmoke test FAILED: expected output to contain "${EXPECTED}" but it did not.`,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
