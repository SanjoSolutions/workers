import { describe, expect, test, vi } from "vitest";
import { claimNextTodoFromTrackers } from "./worker-claim-selection.js";
import type { PollableTaskTracker } from "./task-tracker-settings.js";
import type { ClaimedTask, ClaimTaskResult } from "./task-trackers.js";

const tracker = {
  tracker: {
    name: "demo",
    kind: "git-todo",
    repo: "/tmp/demo",
    file: "TODO.md",
  },
  source: "project",
} satisfies PollableTaskTracker;

function createClaimedTask(summary: string): ClaimedTask {
  return {
    trackerName: "demo",
    trackerKind: "git-todo",
    trackerBasePath: "/tmp/demo",
    item: `- ${summary}`,
    itemType: "unknown",
    itemAgent: "codex",
    summary,
    localTodoContent: "# TODOs\n",
    syncState: {
      kind: "git-todo",
      todoPath: "/tmp/demo/TODO.md",
      repoRoot: "/tmp/demo",
      todoRelativePath: "TODO.md",
    },
  };
}

describe("claimNextTodoFromTrackers", () => {
  test("returns the first claimed task from the polling order", async () => {
    const claimTaskFromTracker = vi
      .fn<[PollableTaskTracker, string, string], Promise<ClaimTaskResult>>()
      .mockResolvedValueOnce({ status: "no-claim", reason: "ready-empty" })
      .mockResolvedValueOnce({
        status: "claimed",
        reason: "claimed",
        claimedTask: createClaimedTask("Ship the change"),
      });

    const result = await claimNextTodoFromTrackers(
      [tracker, tracker],
      "codex",
      "/workspace/project",
      { claimTaskFromTracker },
    );

    expect(claimTaskFromTracker).toHaveBeenNthCalledWith(
      1,
      tracker,
      "codex",
      "/workspace/project",
    );
    expect(claimTaskFromTracker).toHaveBeenNthCalledWith(
      2,
      tracker,
      "codex",
      "/workspace/project",
    );
    expect(result).toEqual({
      claimedTask: expect.objectContaining({
        summary: "Ship the change",
      }),
    });
  });

  test("prefers conflict blocking over no matching agent and empty ready queues", async () => {
    const claimTaskFromTracker = vi
      .fn<[PollableTaskTracker, string, string], Promise<ClaimTaskResult>>()
      .mockResolvedValueOnce({ status: "no-claim", reason: "ready-empty" })
      .mockResolvedValueOnce({ status: "no-claim", reason: "no-matching-agent" })
      .mockResolvedValueOnce({ status: "no-claim", reason: "all-blocked-by-conflict" });

    const result = await claimNextTodoFromTrackers(
      [tracker, tracker, tracker],
      "codex",
      "/workspace/project",
      { claimTaskFromTracker },
    );

    expect(result).toEqual({
      reason: "all-blocked-by-conflict",
    });
  });
});
