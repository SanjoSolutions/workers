/**
 * On-demand CLI feature check for Claude Code.
 *
 * Verifies the exact non-interactive worker invocation pattern we rely on:
 * `--append-system-prompt-file`, `--add-dir`, `-p`,
 * `--dangerously-skip-permissions`, and `--allowedTools`.
 *
 * Run this when installing or updating the Claude CLI.
 */

import { spawnSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getDefaultClaudeAllowedTools } from "../../agent-strategies/claude/interactive.js";
import {
  assertFeatureCheckSucceeded,
  createTemporaryProject,
  featureCheckPrompt,
  prepareFeatureCheckSystemPrompt,
} from "./shared.js";

async function main(): Promise<void> {
  const projectPath = createTemporaryProject("workers-cli-feature-claude-");
  const addDirectory = mkdtempSync(path.join(tmpdir(), "workers-cli-feature-claude-add-dir-"));
  const preparedSystemPrompt = prepareFeatureCheckSystemPrompt("claude");

  const result = spawnSync(
    "claude",
    [
      "--append-system-prompt-file",
      preparedSystemPrompt.filePath,
      "--add-dir",
      addDirectory,
      "-p",
      featureCheckPrompt,
      "--dangerously-skip-permissions",
      "--allowedTools",
      getDefaultClaudeAllowedTools().join(","),
    ],
    {
      cwd: projectPath,
      encoding: "utf8",
      env: process.env,
      timeout: 120_000,
    },
  );

  assertFeatureCheckSucceeded(result, "Claude");
}

main().catch((error) => {
  console.error("Claude CLI feature check failed:", error);
  process.exit(1);
});
