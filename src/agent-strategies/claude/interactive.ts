import type { ManagedInteractiveSession } from "../managed-interactive.js";
import { setupManagedInteractiveSession } from "../managed-interactive.js";

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

export function getDefaultClaudeAllowedTools(): string[] {
  return [...DEFAULT_CLAUDE_ALLOWED_TOOLS];
}

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
