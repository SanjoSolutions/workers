import { readFileSync, writeFileSync } from "fs";
import path from "path";
import {
  claimFromTodoText,
  removeInProgressItemBySummary,
  withTodoLock,
} from "../../claim-todo.js";
import { resolveGitRepoRoot } from "../../git-utils.js";
import type { ResolvedGitTodoTaskTracker } from "../../task-tracker-settings.js";
import { commitAndPushTodoRepo, fastForwardRepo } from "./git-sync.js";
import type {
  ClaimItemResult,
  ClaimedItem,
  CompletionSyncResult,
} from "../types.js";

export async function claimTaskFromGitTodoTracker(
  tracker: ResolvedGitTodoTaskTracker,
  cli: string,
): Promise<ClaimItemResult> {
  const repoRoot = await resolveGitRepoRoot(tracker.repo);
  const todoPath = path.resolve(repoRoot, tracker.file);
  const todoRelativePath = path.relative(repoRoot, todoPath);

  if (!(await fastForwardRepo(repoRoot))) {
    throw new Error(`Failed to sync task tracker ${tracker.name}.`);
  }

  const content = readFileSync(todoPath, "utf8");
  const selection = claimFromTodoText(content, { agent: cli });
  if (selection.status !== "claimed") {
    return {
      status: "no-claim",
      reason: selection.reason,
    };
  }

  const pushed = await withTodoLock(todoPath, async () => {
    const lockedContent = readFileSync(todoPath, "utf8");
    const claimResult = claimFromTodoText(lockedContent, { agent: cli });
    if (claimResult.status !== "claimed") {
      return false;
    }

    writeFileSync(todoPath, claimResult.updatedContent, "utf8");
    const claimSummary = claimResult.item.split("\n")[0].replace(/^- /, "");
    return commitAndPushTodoRepo(
      repoRoot,
      todoRelativePath,
      `chore(todo): claim TODO — ${claimSummary}`,
    );
  });

  if (!pushed) {
    throw new Error(`Failed to commit/push claimed TODO in ${tracker.name}.`);
  }

  const claimedContent = readFileSync(todoPath, "utf8");
  const summary = selection.item.split("\n")[0].replace(/^- /, "");

  const claimedItem = {
    trackerName: tracker.name,
    trackerKind: "git-todo" as const,
    trackerBasePath: repoRoot,
    item: selection.item,
    itemType: selection.itemType,
    itemAgent: selection.itemAgent,
    summary,
    localTodoContent: claimedContent,
    syncState: {
      kind: "git-todo" as const,
      todoPath,
      repoRoot,
      todoRelativePath,
    },
  };

  return {
    status: "claimed",
    reason: "claimed",
    claimedItem,
    claimedTask: claimedItem,
  };
}

export async function syncCompletedGitTodoTask(
  claimedItem: ClaimedItem,
  localTodoPath: string,
): Promise<CompletionSyncResult> {
  const syncState = claimedItem.syncState;
  if (syncState.kind !== "git-todo") {
    throw new Error(`Expected git-todo sync state for ${claimedItem.summary}.`);
  }

  const syncedCompletion = await withTodoLock(syncState.todoPath, async () => {
    const sharedContent = readFileSync(syncState.todoPath, "utf8");
    const removal = removeInProgressItemBySummary(sharedContent, claimedItem.summary);
    if (removal.status !== "removed") {
      return true;
    }

    writeFileSync(syncState.todoPath, removal.updatedContent, "utf8");
    return commitAndPushTodoRepo(
      syncState.repoRoot,
      syncState.todoRelativePath,
      `chore(todo): complete TODO — ${claimedItem.summary}`,
    );
  });

  if (!syncedCompletion) {
    throw new Error(
      `Failed to commit/push completed TODO in ${claimedItem.trackerName}.`,
    );
  }

  writeFileSync(localTodoPath, readFileSync(syncState.todoPath, "utf8"), "utf8");
  return {
    status: "synced",
  };
}
