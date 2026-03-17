import { extractTodoField } from "../agent-prompt.js";
import type { AgentStrategy } from "./types.js";
import { spawnAgentProcess } from "./process.js";
import {
  setupManagedInteractiveSession,
  spawnManagedInteractiveAgent,
  type ManagedInteractiveSession,
} from "./managed-interactive.js";

export function setupManagedInteractiveCodexSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
): ManagedInteractiveSession {
  return setupManagedInteractiveSession(worktreePath, claimedTodoItem, nextPrompt, env, {
    controlDirName: "workers-codex-interactive",
    configDirName: ".codex",
    configFileName: "hooks.json",
    hookEventName: "Stop",
    hookScriptName: "codex-stop-hook.mjs",
    hookEntry: (command) => ({
      type: "command",
      command,
      timeoutSec: 10,
      statusMessage: "workers interactive stop hook",
    }),
    statusEnvVar: "WORKERS_CODEX_STATUS_FILE",
  });
}

export class CodexAgentStrategy implements AgentStrategy {
  readonly cli = "codex" as const;

  async launch(context: Parameters<AgentStrategy["launch"]>[0]) {
    const codexModel =
      extractTodoField(context.claimedTodoItem, "Model") ||
      context.options.model ||
      context.config?.agent?.model ||
      context.options.modelDefault;
    const reasoningEffort =
      extractTodoField(context.claimedTodoItem, "Reasoning") ||
      context.options.reasoningEffort ||
      context.config?.agent?.codexDefaultReasoning ||
      "high";

    const codexArgs = [
      ...(codexModel ? ["--model", codexModel] : []),
      "--config",
      `model_reasoning_effort=${reasoningEffort}`,
    ];
    for (const dir of context.config?.agent?.codexWritableDirs ?? []) {
      codexArgs.push("--add-dir", dir);
    }
    codexArgs.push(
      "--config",
      "sandbox_workspace_write.network_access=true",
    );

    if (context.noTodo) {
      return spawnAgentProcess({
        command: "codex",
        args: codexArgs,
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
    }

    if (context.options.interactive) {
      const managedSession = setupManagedInteractiveCodexSession(
        context.worktreePath,
        context.claimedTodoItem,
        context.nextPrompt,
        context.env,
      );
      return spawnManagedInteractiveAgent(
        "codex",
        ["--enable", "codex_hooks", ...codexArgs, managedSession.nextPrompt],
        context.worktreePath,
        managedSession.env,
        managedSession.statusFile,
        managedSession.cleanup,
      );
    }

    return spawnAgentProcess({
      command: "codex",
      args: [
        "exec",
        "--full-auto",
        "--config",
        "approval_policy=never",
        ...codexArgs,
        context.nextPrompt,
      ],
      cwd: context.worktreePath,
      env: context.env,
      captureOutput: true,
    });
  }
}
