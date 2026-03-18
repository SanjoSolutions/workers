#!/usr/bin/env node

import { Command } from "commander";
import { VALID_CLI_SET, ensureAssistantCli, ensureDefaultTaskTracker, loadSettings, determinePackageRoot } from "../settings.js";
import { getAgentStrategy } from "../agent-strategies/index.js";
import type { CliName, CliOptions } from "../types.js";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("assistant")
    .description("Launch an interactive assistant agent session")
    .option("--cli <name>", "CLI to use (claude, codex, or gemini)");

  program.parse(process.argv);
  const opts = program.opts();

  const repoRoot = determinePackageRoot();
  const settings = await loadSettings(repoRoot);

  let cli: CliName;
  if (opts.cli) {
    if (!VALID_CLI_SET.has(opts.cli as CliName)) {
      throw new Error(`Unsupported CLI: ${opts.cli} (expected: claude, codex, gemini)`);
    }
    cli = opts.cli as CliName;
  } else {
    cli = await ensureAssistantCli(settings);
  }

  await ensureDefaultTaskTracker(settings);

  const options: CliOptions = {
    cli,
    worktreeDir: "~/.worktrees",
    reuseWorktree: true,
    cleanup: false,
    cleanupStale: false,
    interactive: true,
    noTodo: true,
    model: undefined,
    reasoningEffort: undefined,
    modelDefault: settings.defaults.model,
  };

  const strategy = getAgentStrategy(cli);
  const result = await strategy.launch({
    options,
    worktreePath: process.cwd(),
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
