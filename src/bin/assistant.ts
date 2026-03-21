#!/usr/bin/env node

import { Command } from "commander";
import { realpathSync } from "fs";
import { pathToFileURL } from "url";
import {
  VALID_CLI_SET,
  ensureAssistantCli,
  getCreatePullRequestSetting,
  loadSettings,
  determinePackageRoot,
} from "../settings.js";
import { getAgentStrategy } from "../agent-strategies/index.js";
import { findGitRepoRoot } from "../git-utils.js";
import { buildAssistantStartupPrompt } from "../assistant-startup-prompt.js";
import {
  applyGitHubTokenForRepo,
  applyGitHubTokenFromSettings,
} from "../task-tracker-settings.js";
import type { CliName, CliOptions } from "../types.js";

export async function runAssistantCli(argv = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("assistant")
    .description("Launch an interactive assistant agent session")
    .option("--cli <name>", "CLI to use (claude, codex, gemini, or pi)");

  program.parse(argv);
  const opts = program.opts();

  const packageRoot = determinePackageRoot();
  const settings = await loadSettings(packageRoot);
  await applyGitHubTokenFromSettings(settings);

  let cli: CliName;
  if (opts.cli) {
    if (!VALID_CLI_SET.has(opts.cli as CliName)) {
      throw new Error(`Unsupported CLI: ${opts.cli} (expected: claude, codex, gemini, pi)`);
    }
    await ensureAssistantCli(settings, undefined, { preferredCli: opts.cli as CliName });
    cli = opts.cli as CliName;
  } else {
    cli = await ensureAssistantCli(settings);
  }

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
    autoModelSelection: settings.defaults.autoModelSelection,
    autoModelSelectionModels: settings.defaults.autoModelSelectionModels,
    autoReasoningEffort: settings.defaults.autoReasoningEffort,
  };

  const strategy = getAgentStrategy(cli);
  const repoRoot = (await findGitRepoRoot(process.cwd())) ?? process.cwd();
  const env: NodeJS.ProcessEnv = { ...process.env };
  await applyGitHubTokenForRepo(settings, repoRoot, env);
  const result = await strategy.launch({
    options,
    worktreePath: process.cwd(),
    claimedTodoItem: "",
    claimedTodoItemType: "",
    nextPrompt: buildAssistantStartupPrompt({
      createPullRequest: getCreatePullRequestSetting(repoRoot, settings.projects),
    }),
    workflowMode: "interactive",
    noTodo: true,
    env,
  });

  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runAssistantCli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
