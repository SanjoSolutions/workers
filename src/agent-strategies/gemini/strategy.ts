import path from "path";
import { extractTodoField } from "../../agent-prompt.js";
import { prepareAssistantSystemPrompt } from "../../assistant-system-prompt.js";
import { determinePackageRoot } from "../../settings.js";
import { spawnManagedInteractiveAgent } from "../managed-interactive.js";
import { spawnAgentProcess } from "../process.js";
import type { AgentStrategy } from "../types.js";
import { setupManagedInteractiveGeminiSession } from "./interactive.js";

export class GeminiAgentStrategy implements AgentStrategy {
  readonly cli = "gemini" as const;

  async launch(context: Parameters<AgentStrategy["launch"]>[0]) {
    const geminiModel =
      extractTodoField(context.claimedTodoItem, "Model") ||
      context.options.model ||
      context.config?.agent?.model ||
      context.options.modelDefault;

    const args = [
      ...(geminiModel ? ["--model", geminiModel] : []),
      "--approval-mode",
      "yolo",
    ];

    const packageRoot = determinePackageRoot();
    const agentType = context.noTodo ? "assistant" : "worker";
    const sourceSystemPromptFile = path.join(packageRoot, "agents", agentType, "SYSTEM.md");
    const preparedAssistantSystemPrompt = context.noTodo
      ? prepareAssistantSystemPrompt(sourceSystemPromptFile, this.cli)
      : null;
    const systemPromptFile = preparedAssistantSystemPrompt?.filePath ?? sourceSystemPromptFile;
    const env = { ...context.env, GEMINI_SYSTEM_MD: systemPromptFile };

    if (context.noTodo) {
      const result = await spawnAgentProcess({
        command: "gemini",
        args,
        cwd: context.worktreePath,
        env,
        captureOutput: false,
      });
      preparedAssistantSystemPrompt?.cleanup();
      return result;
    }

    if (context.options.interactive) {
      const managedSession = setupManagedInteractiveGeminiSession(
        context.worktreePath,
        context.claimedTodoItem,
        context.nextPrompt,
        env,
      );
      return spawnManagedInteractiveAgent(
        "gemini",
        [...args, managedSession.nextPrompt],
        context.worktreePath,
        managedSession.env,
        managedSession.statusFile,
        () => {
          preparedAssistantSystemPrompt?.cleanup();
          managedSession.cleanup();
        },
      );
    }

    return spawnAgentProcess({
      command: "gemini",
      args: [...args, context.nextPrompt],
      cwd: context.worktreePath,
      env,
      captureOutput: true,
    });
  }
}
