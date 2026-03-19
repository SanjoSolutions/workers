import type { PollableTaskTracker } from "./task-tracker-settings.js";
import {
  claimItemFromTracker,
  type ClaimItemResult,
  type ClaimedItem,
} from "./task-trackers.js";

interface ClaimNextItemDependencies {
  claimItemFromTracker: (
    tracker: PollableTaskTracker,
    cli: string,
    invocationPath: string,
  ) => Promise<ClaimItemResult>;
}

const defaultDependencies: ClaimNextItemDependencies = {
  claimItemFromTracker,
};

export async function claimNextItemFromTrackers(
  trackers: PollableTaskTracker[],
  cli: string,
  invocationPath: string,
  dependencies: ClaimNextItemDependencies = defaultDependencies,
): Promise<{ claimedItem: ClaimedItem } | { reason: string }> {
  let sawMatchingIssue = false;
  let sawBlockedIssue = false;
  let sawReadyEmpty = false;

  for (const tracker of trackers) {
    const claimResult = await dependencies.claimItemFromTracker(
      tracker,
      cli,
      invocationPath,
    );
    if (claimResult.status === "claimed" && claimResult.claimedItem) {
      return {
        claimedItem: claimResult.claimedItem,
      };
    }

    if (claimResult.reason === "all-blocked-by-conflict") {
      sawBlockedIssue = true;
    } else if (claimResult.reason === "no-matching-agent") {
      sawMatchingIssue = true;
    } else if (claimResult.reason === "ready-empty") {
      sawReadyEmpty = true;
    }
  }

  return {
    reason: sawBlockedIssue
      ? "all-blocked-by-conflict"
      : sawMatchingIssue
        ? "no-matching-agent"
        : sawReadyEmpty
          ? "ready-empty"
          : "no-claimable-trackers",
  };
}
