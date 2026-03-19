import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaimedTask } from "./task-trackers.js";

const ghCommands: string[] = [];
const ghResults: Array<{ exitCode: number; stdout: string; stderr?: string }> = [];

vi.mock("zx", () => ({
  $: (strings: TemplateStringsArray, ...values: unknown[]) => {
    let command = "";
    for (const [index, chunk] of strings.entries()) {
      command += chunk;
      if (index < values.length) {
        command += String(values[index]);
      }
    }

    ghCommands.push(command.replace(/\s+/g, " ").trim());

    return {
      quiet() {
        return this;
      },
      async nothrow() {
        return ghResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
      },
    };
  },
}));

const { createWorkerPullRequest } = await import("./github-pr.js");

function createClaimedTask(): ClaimedTask {
  return {
    trackerName: "workers",
    trackerKind: "github-issues",
    trackerBasePath: "/home/jonas/workers",
    item: "- Increase automated confidence for core workflows\n  - Repo: /home/jonas/workers\n  - Type: Development task",
    itemType: "development-task",
    itemAgent: "codex",
    summary: "Increase automated confidence for core workflows",
    localTodoContent: "",
    syncState: {
      kind: "github-issues",
      repository: "SanjoSolutions/workers",
      issueNumber: 25,
      labels: {
        ready: "workers:ready-to-be-picked-up",
        inProgress: "workers:in-progress",
        prReady: "workers:pr-ready",
      },
    },
  };
}

describe("createWorkerPullRequest", () => {
  beforeEach(() => {
    ghCommands.length = 0;
    ghResults.length = 0;
  });

  test("strips repo metadata from the pull request body and moves the issue to pr-ready", async () => {
    ghResults.push(
      { exitCode: 0, stdout: "abc123 Add coverage checks\n" },
      { exitCode: 0, stdout: "git@github.com:SanjoSolutions/workers.git\n" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "abc123 Add coverage checks\n" },
      { exitCode: 0, stdout: "https://github.com/SanjoSolutions/workers/pull/30\n" },
      { exitCode: 0, stdout: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          labels: [{ name: "workers:in-progress" }],
        }),
      },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    );

    const result = await createWorkerPullRequest({
      repoRoot: "/tmp/workers",
      branchName: "work/test-branch",
      claimedTask: createClaimedTask(),
    });

    expect(result).toEqual({
      status: "created",
      url: "https://github.com/SanjoSolutions/workers/pull/30",
    });
    expect(ghCommands).toEqual([
      "git -C /tmp/workers log --oneline work/test-branch --not --remotes --not --exclude=work/test-branch --branches",
      "git -C /tmp/workers remote get-url origin",
      "git -C /tmp/workers push origin work/test-branch",
      "git -C /tmp/workers log --oneline --no-merges work/test-branch --not --remotes --not --exclude=work/test-branch --branches",
      expect.stringContaining("gh pr create --repo SanjoSolutions/workers --head work/test-branch --title Increase automated confidence for core workflows --body"),
      "gh label create workers:pr-ready --repo SanjoSolutions/workers --force --color 5319E7 --description Workers pull request ready queue",
      "gh issue view 25 --repo SanjoSolutions/workers --json labels",
      "gh issue edit 25 --repo SanjoSolutions/workers --remove-label workers:in-progress",
      "gh issue edit 25 --repo SanjoSolutions/workers --add-label workers:pr-ready",
    ]);

    expect(ghCommands[4]).toContain("Closes #25");
    expect(ghCommands[4]).not.toContain("- Repo: /home/jonas/workers");
  });
});
