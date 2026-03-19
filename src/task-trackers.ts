import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { todoContainsSummary } from "./claim-todo.js";
import type { PollableTaskTracker } from "./task-tracker-settings.js";
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
  ClaimItemResult,
  ClaimedItem,
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

export async function claimItemFromTracker(
  pollableTracker: PollableTaskTracker,
  cli: string,
  invocationPath: string,
): Promise<import("./task-trackers/types.js").ClaimItemResult> {
  return pollableTracker.tracker.kind === "github-issues"
    ? claimTaskFromGitHubIssuesTracker(pollableTracker.tracker, cli, invocationPath)
    : claimTaskFromGitTodoTracker(pollableTracker.tracker, cli);
}

export function syncClaimedItemToLocal(
  claimedItem: import("./task-trackers/types.js").ClaimedItem,
  localTodoPath: string,
): void {
  mkdirSync(path.dirname(localTodoPath), { recursive: true });
  writeFileSync(localTodoPath, claimedItem.localTodoContent, "utf8");
}

export async function syncCompletedItem(
  claimedItem: import("./task-trackers/types.js").ClaimedItem,
  localTodoPath: string,
): Promise<import("./task-trackers/types.js").CompletionSyncResult> {
  const localTodoContent = readFileSync(localTodoPath, "utf8");
  if (todoContainsSummary(localTodoContent, claimedItem.summary)) {
    return {
      status: "pending",
    };
  }

  const syncState = claimedItem.syncState;
  return syncState.kind === "git-todo"
    ? syncCompletedGitTodoTask(claimedItem, localTodoPath)
    : syncCompletedGitHubIssueTask(claimedItem);
}
