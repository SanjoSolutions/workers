import type { ManagedInteractiveSession } from "../managed-interactive.js";
import { setupManagedInteractiveSession } from "../managed-interactive.js";

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
