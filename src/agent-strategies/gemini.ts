import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import type { AgentStrategy } from "./types.js";
import { spawnAgentProcess } from "./process.js";
import { extractTodoField } from "../agent-prompt.js";
import { determinePackageRoot } from "../settings.js";
import {
  workersInteractiveInstructions,
  parseJsonConfig,
  spawnManagedInteractiveAgent,
  type ManagedInteractiveSession,
} from "./managed-interactive.js";

export function setupManagedInteractiveGeminiSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
): ManagedInteractiveSession {
  const packageRoot = determinePackageRoot();

  // Create control dir and status file
  const controlDir = path.join(worktreePath, ".tmp", "workers-gemini-interactive");
  mkdirSync(controlDir, { recursive: true });
  const statusFile = path.join(controlDir, "status.json");
  writeFileSync(
    statusFile,
    `${JSON.stringify({ status: "running", source: "workers" })}\n`,
    "utf8",
  );

  // Load hook config from declarative source in agents/worker/.gemini/settings.json
  const declarativeSettingsPath = path.join(
    packageRoot,
    "agents",
    "worker",
    ".gemini",
    "settings.json",
  );
  const declarativeSettings = existsSync(declarativeSettingsPath)
    ? parseJsonConfig(declarativeSettingsPath, readFileSync(declarativeSettingsPath, "utf8"))
    : {};
  const declarativeHooks =
    declarativeSettings.hooks &&
    typeof declarativeSettings.hooks === "object" &&
    !Array.isArray(declarativeSettings.hooks)
      ? (declarativeSettings.hooks as Record<string, unknown[]>)
      : {};

  // Merge declarative hooks into worktree's .gemini/settings.json
  const configDir = path.join(worktreePath, ".gemini");
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "settings.json");
  const originalConfigJson = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const parsed = originalConfigJson ? parseJsonConfig(configPath, originalConfigJson) : {};
  const existingHooks =
    parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks)
      ? { ...(parsed.hooks as Record<string, unknown[]>) }
      : {};
  const mergedHooks: Record<string, unknown[]> = { ...existingHooks };
  for (const [event, defs] of Object.entries(declarativeHooks)) {
    if (!Array.isArray(defs)) continue;
    const existing = Array.isArray(mergedHooks[event]) ? [...mergedHooks[event]] : [];
    mergedHooks[event] = [...existing, ...defs];
  }
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...parsed, hooks: mergedHooks }, null, 2)}\n`,
    "utf8",
  );

  const claimedSummary = claimedTodoItem.split("\n")[0].replace(/^- /, "");
  const localTodoPath = path.resolve(
    worktreePath,
    process.env.WORKERS_LOCAL_TODO_PATH?.trim() || "TODO.md",
  );
  const hookScript = path.join(packageRoot, "src", "scripts", "gemini-after-agent-hook.mjs");

  return {
    env: {
      ...env,
      WORKERS_GEMINI_STATUS_FILE: statusFile,
      WORKERS_GEMINI_HOOK_SCRIPT: hookScript,
      WORKERS_TODO_SUMMARY: claimedSummary,
      WORKERS_LOCAL_TODO_PATH: localTodoPath,
    },
    nextPrompt: `${nextPrompt}\n\n${workersInteractiveInstructions()}`,
    statusFile,
    cleanup: () => {
      if (originalConfigJson === null) {
        rmSync(configPath, { force: true });
      } else {
        writeFileSync(configPath, originalConfigJson, "utf8");
      }
    },
  };
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
      "yolo",
    ];

    const packageRoot = determinePackageRoot();
    const agentType = context.noTodo ? "assistant" : "worker";
    const systemPromptFile = path.join(packageRoot, "agents", agentType, "SYSTEM.md");
    const env = { ...context.env, GEMINI_SYSTEM_MD: systemPromptFile };

    if (context.noTodo) {
      return spawnAgentProcess({
        command: "gemini",
        args,
        cwd: context.worktreePath,
        env,
        captureOutput: false,
      });
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
        managedSession.cleanup,
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
