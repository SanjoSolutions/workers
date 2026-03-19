import { readFileSync } from "fs";
import path from "path";
import { extractTodoField } from "../../agent-prompt.js";
import { prepareSystemPrompt } from "../../assistant-system-prompt.js";
import { determinePackageRoot } from "../../settings.js";
import { spawnManagedInteractiveAgent } from "../managed-interactive.js";
import { spawnAgentProcess } from "../process.js";
import type { AgentStrategy } from "../types.js";
import { setupManagedInteractivePiSession } from "./interactive.js";

const DEFAULT_PI_TOOLS = ["read", "bash", "edit", "write"];

export class PiAgentStrategy implements AgentStrategy {
  readonly cli = "pi" as const;

  async launch(context: Parameters<AgentStrategy["launch"]>[0]) {
    const piModel =
      extractTodoField(context.claimedTodoItem, "Model") ||
      context.options.model ||
      context.config?.agent?.piDefaultModel ||
      context.options.modelDefault;

    const piTools = (
      context.config?.agent?.piDefaultTools ?? DEFAULT_PI_TOOLS
    ).join(",");

    const packageRoot = determinePackageRoot();
    const agentType = context.noTodo ? "assistant" : "worker";
    const systemPromptFile = path.join(packageRoot, "agents", agentType, "SYSTEM.md");
    const preparedSystemPrompt = prepareSystemPrompt(systemPromptFile, this.cli);
    const systemPromptContent = preparedSystemPrompt.content;

    const baseArgs = [
      ...(piModel ? ["--model", piModel] : []),
      "--tools", piTools,
      "--system-prompt", systemPromptContent,
    ];

    if (context.noTodo) {
      const result = await spawnAgentProcess({
        command: "pi",
        args: baseArgs,
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
      preparedSystemPrompt.cleanup();
      return result;
    }

    const extensionPath = path.join(packageRoot, "src", "scripts", "pi-agent-end-extension.mjs");

    if (context.options.interactive) {
      const managedSession = setupManagedInteractivePiSession(
        context.worktreePath,
        context.claimedTodoItem,
        context.nextPrompt,
        context.env,
      );
      return spawnManagedInteractiveAgent(
        "pi",
        [...baseArgs, "--extension", extensionPath, managedSession.nextPrompt],
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
      command: "pi",
      args: [...baseArgs, "-p", context.nextPrompt],
      cwd: context.worktreePath,
      env: context.env,
      captureOutput: true,
    });
  }
}
