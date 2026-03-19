import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { todoContainsSummary } from "./claim-todo.js";
import type {
  PollableTaskTracker,
} from "./task-tracker-settings.js";
import {
  claimTaskFromGitHubIssuesTracker,
  createGitHubIssueTask,
  getGitHubIssueSection,
  listOpenGitHubIssues,
  partitionGitHubIssuesBySection,
  syncCompletedGitHubIssueTask,
} from "./task-trackers/github-issues/index.js";
import {
  commitAndPushTodoRepo,
  fastForwardRepo,
} from "./task-trackers/git-todo/git-sync.js";
import {
  claimTaskFromGitTodoTracker,
  syncCompletedGitTodoTask,
} from "./task-trackers/git-todo/index.js";
export type {
  ClaimTaskResult,
  ClaimedTask,
  CompletionSyncResult,
  GitHubIssue,
  GitHubIssueSection,
} from "./task-trackers/types.js";
export {
  commitAndPushTodoRepo,
  createGitHubIssueTask,
  fastForwardRepo,
  getGitHubIssueSection,
  listOpenGitHubIssues,
  partitionGitHubIssuesBySection,
};

export async function claimTaskFromTracker(
  pollableTracker: PollableTaskTracker,
  cli: string,
  invocationPath: string,
): Promise<import("./task-trackers/types.js").ClaimTaskResult> {
  return pollableTracker.tracker.kind === "github-issues"
    ? claimTaskFromGitHubIssuesTracker(pollableTracker.tracker, cli, invocationPath)
    : claimTaskFromGitTodoTracker(pollableTracker.tracker, cli);
}

export function syncClaimedTaskToLocal(
  claimedTask: import("./task-trackers/types.js").ClaimedTask,
  localTodoPath: string,
): void {
  mkdirSync(path.dirname(localTodoPath), { recursive: true });
  writeFileSync(localTodoPath, claimedTask.localTodoContent, "utf8");
}

export async function syncCompletedTask(
  claimedTask: import("./task-trackers/types.js").ClaimedTask,
  localTodoPath: string,
): Promise<import("./task-trackers/types.js").CompletionSyncResult> {
  const localTodoContent = readFileSync(localTodoPath, "utf8");
  if (todoContainsSummary(localTodoContent, claimedTask.summary)) {
    return {
      status: "pending",
    };
  }

  const syncState = claimedTask.syncState;
  return syncState.kind === "git-todo"
    ? syncCompletedGitTodoTask(claimedTask, localTodoPath)
    : syncCompletedGitHubIssueTask(claimedTask);
}
