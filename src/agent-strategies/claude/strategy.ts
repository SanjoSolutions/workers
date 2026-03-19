import path from "path";
import { extractTodoField } from "../../agent-prompt.js";
import { prepareSystemPrompt } from "../../assistant-system-prompt.js";
import { evaluateClaudeModel } from "../../model-selection.js";
import { determinePackageRoot } from "../../settings.js";
import { spawnManagedInteractiveAgent } from "../managed-interactive.js";
import { spawnAgentProcess } from "../process.js";
import type { AgentStrategy } from "../types.js";
import {
  getDefaultClaudeAllowedTools,
  setupManagedInteractiveClaudeSession,
} from "./interactive.js";

export class ClaudeAgentStrategy implements AgentStrategy {
  readonly cli = "claude" as const;

  async launch(context: Parameters<AgentStrategy["launch"]>[0]) {
    const claudeAllowedTools = (
      context.config?.agent?.claudeAllowedTools ?? getDefaultClaudeAllowedTools()
    ).join(",");
    const claudeModel =
      extractTodoField(context.claimedTodoItem, "Model") ||
      context.options.model ||
      context.config?.agent?.claudeDefaultModel ||
      (context.claimedTodoItem ? await evaluateClaudeModel(context.claimedTodoItem) : undefined);

    const modelArgs = claudeModel ? ["--model", claudeModel] : [];

    const packageRoot = determinePackageRoot();
    const agentType = context.noTodo ? "assistant" : "worker";
    const agentDir = path.join(packageRoot, "agents", agentType);
    const sourceSystemPromptFile = path.join(agentDir, "SYSTEM.md");
    const preparedSystemPrompt = prepareSystemPrompt(sourceSystemPromptFile, this.cli);
    const systemPromptFile = preparedSystemPrompt.filePath;
    const systemPromptArgs = [
      "--append-system-prompt-file", systemPromptFile,
      "--add-dir", agentDir,
    ];

    if (context.noTodo) {
      const result = await spawnAgentProcess({
        command: "claude",
        args: [...modelArgs, ...systemPromptArgs, "--allowedTools", claudeAllowedTools],
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
      preparedSystemPrompt.cleanup();
      return result;
    }

    if (context.options.interactive) {
      const managedSession = setupManagedInteractiveClaudeSession(
        context.worktreePath,
        context.claimedTodoItem,
        context.nextPrompt,
        context.env,
      );
      return spawnManagedInteractiveAgent(
        "claude",
        [
          ...modelArgs,
          ...systemPromptArgs,
          "--allowedTools",
          claudeAllowedTools,
          "--",
          managedSession.nextPrompt,
        ],
        context.worktreePath,
        managedSession.env,
        managedSession.statusFile,
        () => {
          preparedSystemPrompt.cleanup();
          managedSession.cleanup();
        },
      );
    }

    return spawnAgentProcess({
      command: "claude",
      args: [
        ...modelArgs,
        ...systemPromptArgs,
        "-p",
        context.nextPrompt,
        "--dangerously-skip-permissions",
        "--allowedTools",
        claudeAllowedTools,
      ],
      cwd: context.worktreePath,
      env: context.env,
      captureOutput: true,
    });
  }
}
