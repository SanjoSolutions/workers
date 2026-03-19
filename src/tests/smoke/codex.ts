/**
 * Smoke test: verify the worker system prompt is picked up by Codex CLI.
 *
 * Requires a real `codex` binary authenticated via OPENAI_API_KEY.
 *
 * Workers passes the worker SYSTEM.md through Codex `model_instructions_file`.
 * This test points Codex at that file directly, then sends a simple prompt and
 * verifies the output contains evidence that the model instructions were
 * followed.
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

  await $`git -C ${projectPath} add -A`.quiet();
  await $`git -C ${projectPath} commit -m "initialize repository"`.quiet();

  return projectPath;
}

const PROMPT =
  "Reply with exactly the text: SYSTEM_INSTRUCTIONS_LOADED. Do not add any other text.";

const EXPECTED = "SYSTEM_INSTRUCTIONS_LOADED";

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "smoke-codex-"));
  const projectPath = await setupProject(root, "codex-test");
  const workersRoot = process.cwd();
  const preparedSystemPrompt = prepareSystemPrompt(
    path.join(workersRoot, "agents", "worker", "SYSTEM.md"),
    "codex",
  );

  console.log(`Project: ${projectPath}\n`);
  console.log("Launching Codex with a simple verification prompt...\n");

  const result = spawnSync(
    "codex",
    [
      "exec",
      "--full-auto",
      "--config",
      "approval_policy=never",
      "--config",
      `model_instructions_file=${JSON.stringify(preparedSystemPrompt.filePath)}`,
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
  console.log("Codex output:");
  console.log(output);

  if (result.status !== 0) {
    console.error(`\nCodex exited with status ${result.status}`);
    process.exit(1);
  }

  if (output.includes(EXPECTED)) {
    console.log("\nSmoke test passed: Codex responded as expected.");
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
