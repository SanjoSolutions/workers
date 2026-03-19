import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ResolvedGitHubIssuesTaskTracker } from "./task-tracker-settings.js";
import type { ClaimedTask } from "./task-trackers.js";

const ghCommands: string[] = [];
const ghResults: Array<{ exitCode: number; stdout: string }> = [];

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
        return ghResults.shift() ?? { exitCode: 0, stdout: "" };
      },
    };
  },
}));

const { createGitHubIssueTask, syncCompletedTask } = await import("./task-trackers.js");

function createTracker(): ResolvedGitHubIssuesTaskTracker {
  return {
    name: "demo",
    kind: "github-issues",
    repository: "acme/widgets",
    defaultRepo: "/tmp/widgets",
    tokenCommand: undefined,
    githubApp: undefined,
    labels: {
      planned: "workers:planned",
      ready: "workers:ready-to-be-picked-up",
      inProgress: "workers:in-progress",
    },
  };
}

describe("syncCompletedTask", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "workers-task-trackers-"));
    ghCommands.length = 0;
    ghResults.length = 0;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("removes GitHub queue labels before closing a completed issue", async () => {
    const localTodoPath = path.join(tempDir, "TODO.md");
    writeFileSync(localTodoPath, "# TODOs\n\n## In progress\n\n## Ready to be picked up\n", "utf8");

    const claimedTask: ClaimedTask = {
      trackerName: "demo",
      trackerKind: "github-issues",
      trackerBasePath: tempDir,
      item: "- Ship the change",
      itemType: "unknown",
      itemAgent: "codex",
      summary: "Ship the change",
      localTodoContent: "",
      syncState: {
        kind: "github-issues",
        repository: "acme/widgets",
        issueNumber: 42,
        labels: {
          planned: "workers:planned",
          ready: "workers:ready-to-be-picked-up",
          inProgress: "workers:in-progress",
        },
      },
    };

    ghResults.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          labels: [
            { name: "workers:ready-to-be-picked-up" },
            { name: "workers:in-progress" },
          ],
        }),
      },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    );

    const result = await syncCompletedTask(claimedTask, localTodoPath);

    expect(result).toEqual({ status: "synced" });
    expect(ghCommands).toEqual([
      "gh issue view 42 --repo acme/widgets --json labels",
      "gh issue edit 42 --repo acme/widgets --remove-label workers:ready-to-be-picked-up",
      "gh issue edit 42 --repo acme/widgets --remove-label workers:in-progress",
      "gh issue close 42 --repo acme/widgets --reason completed",
    ]);
  });
});

describe("createGitHubIssueTask", () => {
  beforeEach(() => {
    ghCommands.length = 0;
    ghResults.length = 0;
  });

  test("omits the Repo field from the created issue body", async () => {
    ghResults.push(
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "https://github.com/acme/widgets/issues/77\n" },
    );

    const issueUrl = await createGitHubIssueTask(createTracker(), "ready", [
      "- Ship the change",
      "  - Type: Development task",
      "  - Repo: /tmp/widgets",
      "  - Context: Keep this detail",
    ]);

    expect(issueUrl).toBe("https://github.com/acme/widgets/issues/77");
    expect(ghCommands).toEqual([
      "gh label create workers:planned --repo acme/widgets --force --color D4C5F9 --description Workers planned queue",
      "gh label create workers:ready-to-be-picked-up --repo acme/widgets --force --color 0E8A16 --description Workers ready queue",
      "gh label create workers:in-progress --repo acme/widgets --force --color FBCA04 --description Workers in-progress queue",
      "gh issue create --repo acme/widgets --title Ship the change --body - Type: Development task - Context: Keep this detail --label workers:ready-to-be-picked-up",
    ]);
  });

  test("omits the Repo field from the updated issue body", async () => {
    ghResults.push(
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    );

    const issueUrl = await createGitHubIssueTask(
      createTracker(),
      "planned",
      [
        "- Ship the change",
        "  - Type: Development task",
        "  - Repo: /tmp/widgets",
        "  - Context: Keep this detail",
      ],
      77,
    );

    expect(issueUrl).toBe("https://github.com/acme/widgets/issues/77");
    expect(ghCommands).toEqual([
      "gh label create workers:planned --repo acme/widgets --force --color D4C5F9 --description Workers planned queue",
      "gh label create workers:ready-to-be-picked-up --repo acme/widgets --force --color 0E8A16 --description Workers ready queue",
      "gh label create workers:in-progress --repo acme/widgets --force --color FBCA04 --description Workers in-progress queue",
      "gh issue edit 77 --repo acme/widgets --title Ship the change --body - Type: Development task - Context: Keep this detail --add-label workers:planned",
    ]);
  });
});
