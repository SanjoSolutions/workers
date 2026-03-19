import { readFileSync } from "fs";
import path from "path";
import { extractTodoField } from "../agent-prompt.js";
import { evaluateCodexSelection } from "../model-selection.js";
import { determinePackageRoot } from "../settings.js";
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
    const explicitModel =
      extractTodoField(context.claimedTodoItem, "Model") ||
      context.options.model ||
      context.config?.agent?.model;
    const explicitReasoningEffort =
      extractTodoField(context.claimedTodoItem, "Reasoning") ||
      context.options.reasoningEffort ||
      context.config?.agent?.codexDefaultReasoning;

    let codexModel = explicitModel || context.options.modelDefault || "gpt-5.4";
    let reasoningEffort = explicitReasoningEffort || "high";

    const shouldAutoSelectModel = !explicitModel
      && context.options.autoModelSelection !== false
      && Boolean(context.claimedTodoItem);
    const shouldAutoSelectReasoningEffort = !explicitReasoningEffort
      && context.options.autoReasoningEffort !== false
      && Boolean(context.claimedTodoItem);

    if (shouldAutoSelectModel || shouldAutoSelectReasoningEffort) {
      const selection = await evaluateCodexSelection(context.claimedTodoItem, {
        candidateModels: context.options.autoModelSelectionModels ?? [codexModel],
        fallbackModel: codexModel,
        fallbackReasoningEffort: reasoningEffort,
      });

      if (shouldAutoSelectModel) {
        codexModel = selection.model;
      }
      if (shouldAutoSelectReasoningEffort) {
        reasoningEffort = selection.reasoningEffort;
      }
    }

    const packageRoot = determinePackageRoot();
    const agentType = context.noTodo ? "assistant" : "worker";
    const systemPromptFile = path.join(packageRoot, "agents", agentType, "SYSTEM.md");
    const systemPrompt = readFileSync(systemPromptFile, "utf8").trim();
    const codexPrompt = [
      "Follow these instructions exactly:",
      systemPrompt,
      context.nextPrompt,
    ]
      .filter((section) => section.trim().length > 0)
      .join("\n\n");

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
        args: [...codexArgs, codexPrompt],
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
        ["--enable", "codex_hooks", ...codexArgs, `${codexPrompt}\n\n${managedSession.nextPrompt}`],
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
        codexPrompt,
      ],
      cwd: context.worktreePath,
      env: context.env,
      captureOutput: true,
    });
  }
}
