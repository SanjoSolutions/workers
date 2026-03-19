/**
 * On-demand CLI feature check for Gemini.
 *
 * Verifies the exact worker invocation pattern we rely on:
 * `GEMINI_SYSTEM_MD` plus `--approval-mode yolo`.
 *
 * Run this when installing or updating the Gemini CLI.
 */

import { spawnSync } from "child_process";
import {
  assertFeatureCheckSucceeded,
  createTemporaryProject,
  featureCheckPrompt,
  prepareFeatureCheckSystemPrompt,
} from "./shared.js";

async function main(): Promise<void> {
  const projectPath = createTemporaryProject("workers-cli-feature-gemini-");
  const preparedSystemPrompt = prepareFeatureCheckSystemPrompt("gemini");

  const result = spawnSync(
    "gemini",
    [
      "--approval-mode",
      "yolo",
      featureCheckPrompt,
    ],
    {
      cwd: projectPath,
      encoding: "utf8",
      env: {
        ...process.env,
        GEMINI_SYSTEM_MD: preparedSystemPrompt.filePath,
      },
      timeout: 120_000,
    },
  );

  assertFeatureCheckSucceeded(result, "Gemini");
}

main().catch((error) => {
  console.error("Gemini CLI feature check failed:", error);
  process.exit(1);
});
