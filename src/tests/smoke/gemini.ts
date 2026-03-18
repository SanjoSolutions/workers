/**
 * Smoke test: verify the worker skill is picked up by Gemini CLI.
 *
 * Requires a real `gemini` binary authenticated via GOOGLE_API_KEY or
 * GEMINI_API_KEY environment variable.
 *
 * Gemini reads its system prompt from the file pointed to by GEMINI_SYSTEM_MD.
 * We point it at the worker SYSTEM.md and send a simple prompt to verify the
 * CLI starts and loads the instructions.
 */

import { spawnSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { $ } from "zx";

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
  const root = mkdtempSync(path.join(tmpdir(), "smoke-gemini-"));
  const projectPath = await setupProject(root, "gemini-test");

  console.log(`Project: ${projectPath}\n`);
  console.log("Launching Gemini with a simple verification prompt...\n");

  const workersRoot = process.cwd();
  const workerSystemPath = path.join(workersRoot, "agents", "worker", "SYSTEM.md");

  const result = spawnSync(
    "gemini",
    [
      "--approval-mode",
      "yolo",
      PROMPT,
    ],
    {
      cwd: projectPath,
      encoding: "utf8",
      env: {
        ...process.env,
        GEMINI_SYSTEM_MD: workerSystemPath,
      },
      timeout: 120_000,
    },
  );

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  console.log("Gemini output:");
  console.log(output);

  if (result.status !== 0) {
    console.error(`\nGemini exited with status ${result.status}`);
    process.exit(1);
  }

  if (output.includes(EXPECTED)) {
    console.log("\nSmoke test passed: Gemini responded as expected.");
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
