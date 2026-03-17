import type { AgentStrategy } from "./types.js";
import { spawnAgentProcess } from "./process.js";
import { extractTodoField } from "../agent-prompt.js";
import {
  setupManagedInteractiveSession,
  spawnManagedInteractiveAgent,
  type ManagedInteractiveSession,
} from "./managed-interactive.js";

export function setupManagedInteractiveGeminiSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
): ManagedInteractiveSession {
  return setupManagedInteractiveSession(worktreePath, claimedTodoItem, nextPrompt, env, {
    controlDirName: "workers-gemini-interactive",
    configDirName: ".gemini",
    configFileName: "settings.json",
    hookEventName: "AfterAgent",
    hookScriptName: "gemini-after-agent-hook.mjs",
    hookEntry: (command) => ({
      name: "workers-interactive-after-agent",
      type: "command",
      command,
      timeout: 10000,
      description: "workers interactive after-agent hook",
    }),
    statusEnvVar: "WORKERS_GEMINI_STATUS_FILE",
  });
}

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
      "auto_edit",
    ];

    if (context.noTodo) {
      return spawnAgentProcess({
        command: "gemini",
        args,
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
    }

    if (context.options.interactive) {
      const managedSession = setupManagedInteractiveGeminiSession(
        context.worktreePath,
        context.claimedTodoItem,
        context.nextPrompt,
        context.env,
      );
      return spawnManagedInteractiveAgent(
        "gemini",
        args,
        context.worktreePath,
        managedSession.env,
        managedSession.statusFile,
        managedSession.cleanup,
      );
    }

    return spawnAgentProcess({
      command: "gemini",
      args: ["--prompt", context.nextPrompt, ...args],
      cwd: context.worktreePath,
      env: context.env,
      captureOutput: true,
    });
  }
}
