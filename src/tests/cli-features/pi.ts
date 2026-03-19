/**
 * On-demand CLI feature check for Pi.
 *
 * Verifies the exact worker invocation pattern we rely on:
 * `--tools`, `--system-prompt`, and `-p`.
 *
 * Run this when installing or updating the Pi CLI.
 */

import { spawnSync } from "child_process";
import {
  assertFeatureCheckSucceeded,
  createTemporaryProject,
  featureCheckPrompt,
  prepareFeatureCheckSystemPrompt,
} from "./shared.js";

async function main(): Promise<void> {
  const projectPath = createTemporaryProject("workers-cli-feature-pi-");
  const preparedSystemPrompt = prepareFeatureCheckSystemPrompt("pi");

  const result = spawnSync(
    "pi",
    [
      "--tools",
      "read,bash,edit,write",
      "--system-prompt",
      preparedSystemPrompt.content,
      "-p",
      featureCheckPrompt,
    ],
    {
      cwd: projectPath,
      encoding: "utf8",
      env: process.env,
      timeout: 120_000,
    },
  );

  assertFeatureCheckSucceeded(result, "Pi");
}

main().catch((error) => {
  console.error("Pi CLI feature check failed:", error);
  process.exit(1);
});
