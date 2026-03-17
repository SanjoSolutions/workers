import { Command } from "commander";
import type { CliName, CliOptions } from "./types.js";
import { ensureWorkerCli, loadSettings } from "./settings.js";

const VALID_CLIS = new Set<CliName>(["claude", "codex", "gemini"]);

export async function parseCliOptions(argv: string[]): Promise<CliOptions> {
  const settings = await loadSettings();
  const program = new Command();

  program
    .name("worker")
    .description("Orchestrate isolated dev environments for AI coding agents")
    .argument("[cli]", "CLI to use (claude, codex, or gemini)")
    .option("--cli <name>", "CLI to use")
    .option("--worktree-dir <dir>", "Worktree root directory", "~/.worktrees")
    .option("--reuse-worktree", "Reuse latest worktree (default)")
    .option("--fresh-worktree", "Force new worktree")
    .option("--cleanup", "Remove worktree on exit")
    .option("--no-cleanup", "Keep worktree on exit (default)")
    .option("--cleanup-stale", "Remove stale worktrees before starting")
    .option("--no-cleanup-stale", "Skip stale worktree cleanup (default)")
    .option("--interactive", "Interactive agent mode")
    .option("--fully-automated", "Non-interactive agent mode (default)")
    .option("--no-isolated-runtime", "Skip isolated runtime setup")
    .option("--setup-only", "Setup worktree + runtime, then exit")
    .option("--no-todo", "Launch agent without claiming a TODO")
    .option("--model <name>", "Override agent model (e.g. opus, sonnet)")
    .option("--reasoning-effort <level>", "Override reasoning effort (low, medium, high, xhigh)");

  const cleanedArgv = argv.filter((arg) => arg !== "--");
  program.parse(cleanedArgv);

  const opts = program.opts();
  const positionalCli = program.args[0] as CliName | undefined;
  const explicitCli = (opts.cli ?? positionalCli) as CliName | undefined;

  let cli: CliName;
  if (explicitCli) {
    if (!VALID_CLIS.has(explicitCli)) {
      throw new Error(
        `Unsupported CLI: ${explicitCli} (expected: claude, codex, gemini)`,
      );
    }
    cli = explicitCli;
  } else {
    cli = await ensureWorkerCli(settings);
  }

  const reuseWorktree = opts.freshWorktree ? false : true;
  const interactive = opts.interactive ? true : false;

  return {
    cli,
    worktreeDir: opts.worktreeDir ?? "~/.worktrees",
    reuseWorktree,
    cleanup: opts.cleanup ?? false,
    cleanupStale: opts.cleanupStale ?? false,
    interactive,
    isolatedRuntime: opts.isolatedRuntime ?? true,
    setupOnly: opts.setupOnly ?? false,
    noTodo: opts.todo === false,
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    modelDefault: settings.defaults.model,
  };
}
