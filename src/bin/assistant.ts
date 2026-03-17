#!/usr/bin/env node

import { loadSettings, workersRepoRoot } from "../settings.js";
import { getAgentStrategy } from "../agent-strategies/index.js";
import type { CliOptions } from "../types.js";

async function main(): Promise<void> {
  const repoRoot = workersRepoRoot();
  const settings = await loadSettings(repoRoot);
  const cli = settings.assistant.defaults.cli;

  const options: CliOptions = {
    cli,
    worktreeDir: "~/.worktrees",
    reuseWorktree: true,
    cleanup: false,
    cleanupStale: false,
    interactive: true,
    isolatedRuntime: false,
    setupOnly: false,
    noTodo: true,
    model: undefined,
    reasoningEffort: undefined,
    modelDefault: settings.defaults.model,
  };

  const strategy = getAgentStrategy(cli);
  const result = await strategy.launch({
    options,
    worktreePath: repoRoot,
    claimedTodoItem: "",
    claimedTodoItemType: "",
    nextPrompt: "",
    workflowMode: "interactive",
    noTodo: true,
    env: { ...process.env },
  });

  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
