import type { PollableTaskTracker } from "./task-tracker-settings.js";
import {
  claimTaskFromTracker,
  type ClaimTaskResult,
  type ClaimedTask,
} from "./task-trackers.js";

interface ClaimNextTodoDependencies {
  claimTaskFromTracker: (
    tracker: PollableTaskTracker,
    cli: string,
    invocationPath: string,
  ) => Promise<ClaimTaskResult>;
}

const defaultDependencies: ClaimNextTodoDependencies = {
  claimTaskFromTracker,
};

export async function claimNextTodoFromTrackers(
  trackers: PollableTaskTracker[],
  cli: string,
  invocationPath: string,
  dependencies: ClaimNextTodoDependencies = defaultDependencies,
): Promise<{ claimedTask: ClaimedTask } | { reason: string }> {
  let sawMatchingIssue = false;
  let sawBlockedIssue = false;
  let sawReadyEmpty = false;

  for (const tracker of trackers) {
    const claimResult = await dependencies.claimTaskFromTracker(
      tracker,
      cli,
      invocationPath,
    );
    if (claimResult.status === "claimed" && claimResult.claimedTask) {
      return {
        claimedTask: claimResult.claimedTask,
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
