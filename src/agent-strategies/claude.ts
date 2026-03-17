import { extractTodoField } from "../agent-prompt.js";
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
      "opus";

    let args: string[];
    let captureOutput: boolean;

    if (context.noTodo) {
      args = ["--model", claudeModel, "--allowedTools", claudeAllowedTools];
      captureOutput = false;
    } else if (context.options.interactive) {
      args = [
        "--model",
        claudeModel,
        "--allowedTools",
        claudeAllowedTools,
        "--",
        context.nextPrompt,
      ];
      captureOutput = false;
    } else {
      args = [
        "--model",
        claudeModel,
        "-p",
        context.nextPrompt,
        "--dangerouslySkipPermissions",
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
