/**
 * Smoke test: verify the worker skill is picked up by Pi CLI.
 *
 * Requires a real `pi` binary. Pi receives system instructions via
 * --system-prompt. We send a simple prompt and verify the output contains
 * evidence that the instructions were loaded.
 */

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "fs";
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
  const root = mkdtempSync(path.join(tmpdir(), "smoke-pi-"));
  const projectPath = await setupProject(root, "pi-test");

  console.log(`Project: ${projectPath}\n`);
  console.log("Launching Pi with a simple verification prompt...\n");

  const workersRoot = process.cwd();
  const workerSystemPath = path.join(workersRoot, "agents", "worker", "SYSTEM.md");
  const systemPromptContent = readFileSync(workerSystemPath, "utf8");

  const result = spawnSync(
    "pi",
    [
      "--system-prompt",
      systemPromptContent,
      "--tools",
      "read,bash,edit,write",
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
  console.log("Pi output:");
  console.log(output);

  if (result.status !== 0) {
    console.error(`\nPi exited with status ${result.status}`);
    process.exit(1);
  }

  if (output.includes(EXPECTED)) {
    console.log("\nSmoke test passed: Pi responded as expected.");
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
