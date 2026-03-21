import { mkdirSync } from "fs";
import path from "path";
import {
  writeInteractiveStatus,
  workersInteractiveInstructions,
  type ManagedInteractiveSession,
} from "../managed-interactive.js";

export function setupManagedInteractivePiSession(
  worktreePath: string,
  claimedTodoItem: string,
  nextPrompt: string,
  env: NodeJS.ProcessEnv,
): ManagedInteractiveSession {
  const controlDir = path.join(worktreePath, ".tmp", "workers-pi-interactive");
  mkdirSync(controlDir, { recursive: true });

  const statusFile = path.join(controlDir, "status.json");
  writeInteractiveStatus(
    statusFile,
    {
      status: "running",
      source: "workers",
      launcherPid: process.pid,
      startedAt: new Date().toISOString(),
    },
    { mergeExisting: false },
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
