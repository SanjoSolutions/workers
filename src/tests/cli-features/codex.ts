/**
 * On-demand CLI feature check for Codex.
 *
 * Verifies the exact non-interactive worker invocation pattern we rely on:
 * `exec --full-auto`, `approval_policy=never`, `model_reasoning_effort=...`,
 * `model_instructions_file=...`, and `sandbox_workspace_write.network_access=true`.
 *
 * Run this when installing or updating the Codex CLI.
 */

import { spawnSync } from "child_process";
import {
  assertFeatureCheckSucceeded,
  createTemporaryProject,
  featureCheckPrompt,
  prepareFeatureCheckSystemPrompt,
} from "./shared.js";

async function main(): Promise<void> {
  const projectPath = createTemporaryProject("workers-cli-feature-codex-");
  const preparedSystemPrompt = prepareFeatureCheckSystemPrompt("codex");

  const result = spawnSync(
    "codex",
    [
      "exec",
      "--full-auto",
      "--config",
      "approval_policy=never",
      "--config",
      "model_reasoning_effort=medium",
      "--config",
      `model_instructions_file=${JSON.stringify(preparedSystemPrompt.filePath)}`,
      "--config",
      "sandbox_workspace_write.network_access=true",
      featureCheckPrompt,
    ],
    {
      cwd: projectPath,
      encoding: "utf8",
      env: process.env,
      timeout: 120_000,
    },
  );

  assertFeatureCheckSucceeded(result, "Codex");
}

main().catch((error) => {
  console.error("Codex CLI feature check failed:", error);
  process.exit(1);
});
