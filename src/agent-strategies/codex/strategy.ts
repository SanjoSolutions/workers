import path from "path";
import { extractTodoField } from "../../agent-prompt.js";
import { prepareSystemPrompt } from "../../assistant-system-prompt.js";
import { evaluateCodexSelection } from "../../model-selection.js";
import { determinePackageRoot } from "../../settings.js";
import { spawnManagedInteractiveAgent } from "../managed-interactive.js";
import { spawnAgentProcess } from "../process.js";
import type { AgentStrategy } from "../types.js";
import { setupManagedInteractiveCodexSession } from "./interactive.js";

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
    const sourceSystemPromptFile = path.join(packageRoot, "agents", agentType, "SYSTEM.md");
    const preparedSystemPrompt = prepareSystemPrompt(sourceSystemPromptFile, this.cli);
    const systemPromptFile = preparedSystemPrompt.filePath;

    const codexArgs = [
      ...(codexModel ? ["--model", codexModel] : []),
      "--config",
      `model_reasoning_effort=${reasoningEffort}`,
      "--config",
      `model_instructions_file=${JSON.stringify(systemPromptFile)}`,
    ];
    for (const dir of context.config?.agent?.codexWritableDirs ?? []) {
      codexArgs.push("--add-dir", dir);
    }
    codexArgs.push(
      "--config",
      "sandbox_workspace_write.network_access=true",
    );

    if (context.noTodo) {
      const result = await spawnAgentProcess({
        command: "codex",
        args: codexArgs,
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
      preparedSystemPrompt.cleanup();
      return result;
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
        ["--enable", "codex_hooks", ...codexArgs, context.nextPrompt, managedSession.nextPrompt]
          .filter((arg) => arg.trim().length > 0),
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
