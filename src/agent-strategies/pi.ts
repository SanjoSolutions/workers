import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { AgentStrategy } from "./types.js";
import { spawnAgentProcess } from "./process.js";
import { extractTodoField } from "../agent-prompt.js";
import { determinePackageRoot } from "../settings.js";
import {
  workersInteractiveInstructions,
  spawnManagedInteractiveAgent,
  type ManagedInteractiveSession,
} from "./managed-interactive.js";

const DEFAULT_PI_TOOLS = ["read", "bash", "edit", "write"];

export function setupManagedInteractivePiSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
): ManagedInteractiveSession {
  const controlDir = path.join(worktreePath, ".tmp", "workers-pi-interactive");
  mkdirSync(controlDir, { recursive: true });

  const statusFile = path.join(controlDir, "status.json");
  writeFileSync(
    statusFile,
    `${JSON.stringify({ status: "running", source: "workers" })}\n`,
    "utf8",
  );

  const claimedSummary = claimedTodoItem.split("\n")[0].replace(/^- /, "");
  const localTodoPath = path.resolve(
    worktreePath,
    process.env.WORKERS_LOCAL_TODO_PATH?.trim() || "TODO.md",
  );

  return {
    env: {
      ...env,
      WORKERS_PI_STATUS_FILE: statusFile,
      WORKERS_TODO_SUMMARY: claimedSummary,
      WORKERS_LOCAL_TODO_PATH: localTodoPath,
    },
    nextPrompt: `${nextPrompt}\n\n${workersInteractiveInstructions()}`,
    statusFile,
    cleanup: () => {
      // No worktree config files were modified; nothing to restore.
    },
  };
}

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
    const systemPromptContent = readFileSync(systemPromptFile, "utf8");

    const baseArgs = [
      ...(piModel ? ["--model", piModel] : []),
      "--tools", piTools,
      "--system-prompt", systemPromptContent,
    ];

    if (context.noTodo) {
      return spawnAgentProcess({
        command: "pi",
        args: baseArgs,
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
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
        managedSession.cleanup,
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
