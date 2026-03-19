import { describe, expect, test, vi } from "vitest";
import { claimNextItemFromTrackers } from "./worker-claim-selection.js";
import type { PollableTaskTracker } from "./task-tracker-settings.js";
import type { ClaimedItem, ClaimItemResult } from "./task-trackers.js";

const tracker = {
  tracker: {
    name: "demo",
    kind: "git-todo",
    repo: "/tmp/demo",
    file: "TODO.md",
  },
  source: "project",
} satisfies PollableTaskTracker;

function createClaimedItem(summary: string): ClaimedItem {
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

describe("claimNextItemFromTrackers", () => {
  test("returns the first claimed item from the polling order", async () => {
    const claimItemFromTracker = vi
      .fn<[PollableTaskTracker, string, string], Promise<ClaimItemResult>>()
      .mockResolvedValueOnce({ status: "no-claim", reason: "ready-empty" })
      .mockResolvedValueOnce({
        status: "claimed",
        reason: "claimed",
        claimedItem: createClaimedItem("Ship the change"),
      });

    const result = await claimNextItemFromTrackers(
      [tracker, tracker],
      "codex",
      "/workspace/project",
      { claimItemFromTracker },
    );

    expect(claimItemFromTracker).toHaveBeenNthCalledWith(
      1,
      tracker,
      "codex",
      "/workspace/project",
    );
    expect(claimItemFromTracker).toHaveBeenNthCalledWith(
      2,
      tracker,
      "codex",
      "/workspace/project",
    );
    expect(result).toEqual({
      claimedItem: expect.objectContaining({
        summary: "Ship the change",
      }),
    });
  });

  test("prefers conflict blocking over no matching agent and empty ready queues", async () => {
    const claimItemFromTracker = vi
      .fn<[PollableTaskTracker, string, string], Promise<ClaimItemResult>>()
      .mockResolvedValueOnce({ status: "no-claim", reason: "ready-empty" })
      .mockResolvedValueOnce({ status: "no-claim", reason: "no-matching-agent" })
      .mockResolvedValueOnce({ status: "no-claim", reason: "all-blocked-by-conflict" });

    const result = await claimNextItemFromTrackers(
      [tracker, tracker, tracker],
      "codex",
      "/workspace/project",
      { claimItemFromTracker },
    );

    expect(result).toEqual({
      reason: "all-blocked-by-conflict",
    });
  });
});
