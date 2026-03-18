import path from "path";
import { extractTodoField } from "../agent-prompt.js";
import { evaluateClaudeModel } from "../model-selection.js";
import { determinePackageRoot } from "../settings.js";
import type { AgentStrategy } from "./types.js";
import { spawnAgentProcess } from "./process.js";

const DEFAULT_CLAUDE_ALLOWED_TOOLS = [
  "Edit",
  "Bash",
  "Read",
  "Write",
  "Glob",
  "Grep",
  "Skill",
  "Task",
  "ToolSearch",
];

export class ClaudeAgentStrategy implements AgentStrategy {
  readonly cli = "claude" as const;

  async launch(context: Parameters<AgentStrategy["launch"]>[0]) {
    const claudeAllowedTools = (
      context.config?.agent?.claudeAllowedTools ?? DEFAULT_CLAUDE_ALLOWED_TOOLS
    ).join(",");
    const claudeModel =
      extractTodoField(context.claimedTodoItem, "Model") ||
      context.options.model ||
      context.config?.agent?.claudeDefaultModel ||
      (context.claimedTodoItem ? await evaluateClaudeModel(context.claimedTodoItem) : undefined);

    const modelArgs = claudeModel ? ["--model", claudeModel] : [];

    const packageRoot = determinePackageRoot();
    const systemPromptFile = context.noTodo
      ? path.join(packageRoot, "ASSISTANT_SYSTEM.md")
      : path.join(packageRoot, "WORKER_SYSTEM.md");
    const systemPromptArgs = ["--append-system-prompt-file", systemPromptFile];

    let args: string[];
    let captureOutput: boolean;

    if (context.noTodo) {
      args = [...modelArgs, ...systemPromptArgs, "--allowedTools", claudeAllowedTools];
      captureOutput = false;
    } else if (context.options.interactive) {
      args = [
        ...modelArgs,
        ...systemPromptArgs,
        "--allowedTools",
        claudeAllowedTools,
        "--",
        context.nextPrompt,
      ];
      captureOutput = false;
    } else {
      args = [
        ...modelArgs,
        ...systemPromptArgs,
        "-p",
        context.nextPrompt,
        "--dangerously-skip-permissions",
        "--allowedTools",
        claudeAllowedTools,
      ];
      captureOutput = true;
    }

    return spawnAgentProcess({
      command: "claude",
      args,
      cwd: context.worktreePath,
      env: context.env,
      captureOutput,
    });
  }
}
