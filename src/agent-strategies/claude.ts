import path from "path";
import { extractTodoField } from "../agent-prompt.js";
import { evaluateClaudeModel } from "../model-selection.js";
import { determinePackageRoot } from "../settings.js";
import type { AgentStrategy } from "./types.js";
import { spawnAgentProcess } from "./process.js";
import {
  setupManagedInteractiveSession,
  spawnManagedInteractiveAgent,
  type ManagedInteractiveSession,
} from "./managed-interactive.js";

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

export function setupManagedInteractiveClaudeSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
): ManagedInteractiveSession {
  return setupManagedInteractiveSession(worktreePath, claimedTodoItem, nextPrompt, env, {
    controlDirName: "workers-claude-interactive",
    configDirName: ".claude",
    configFileName: "settings.local.json",
    hookEventName: "Stop",
    hookScriptName: "claude-stop-hook.mjs",
    hookEntry: (command) => ({
      type: "command",
      command,
      timeout: 10,
    }),
    statusEnvVar: "WORKERS_CLAUDE_STATUS_FILE",
  });
}

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
      (context.claimedTodoItem ? await evaluateClaudeModel(context.claimedTodoItem) : undefined);

    const modelArgs = claudeModel ? ["--model", claudeModel] : [];

    const packageRoot = determinePackageRoot();
    const agentType = context.noTodo ? "assistant" : "worker";
    const agentDir = path.join(packageRoot, "agents", agentType);
    const systemPromptFile = path.join(agentDir, "SYSTEM.md");
    const systemPromptArgs = [
      "--append-system-prompt-file", systemPromptFile,
      "--add-dir", agentDir,
    ];

    if (context.noTodo) {
      return spawnAgentProcess({
        command: "claude",
        args: [...modelArgs, ...systemPromptArgs, "--allowedTools", claudeAllowedTools],
        cwd: context.worktreePath,
        env: context.env,
        captureOutput: false,
      });
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
        managedSession.cleanup,
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
