import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  PollableTaskTracker,
  ResolvedGitHubIssuesTaskTracker,
} from "./task-tracker-settings.js";
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

const {
  claimTaskFromTracker,
  createGitHubIssueTask,
  syncCompletedTask,
} = await import("./task-trackers.js");

function renderWorkerTaskSpecComment(item: string): string {
  return [
    "<!-- workers-task-spec:v1 -->",
    "```text",
    item,
    "```",
    "<!-- /workers-task-spec -->",
  ].join("\n");
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

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

function createPollableTracker(): PollableTaskTracker {
  return {
    tracker: createTracker(),
    source: "project",
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

  test("creates a structured worker comment for new issues", async () => {
    ghResults.push(
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "https://github.com/acme/widgets/issues/77\n" },
      { exitCode: 0, stdout: "" },
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
      normalizeCommand(
        `gh api repos/acme/widgets/issues/77/comments --method POST -f body=${renderWorkerTaskSpecComment("- Ship the change\n  - Type: Development task\n  - Repo: /tmp/widgets\n  - Context: Keep this detail")}`,
      ),
    ]);
  });

  test("preserves an existing issue title and body and appends a structured worker comment", async () => {
    ghResults.push(
      { exitCode: 0, stdout: "" },
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
      "gh issue edit 77 --repo acme/widgets --add-label workers:planned",
      normalizeCommand(
        `gh api repos/acme/widgets/issues/77/comments --method POST -f body=${renderWorkerTaskSpecComment("- Ship the change\n  - Type: Development task\n  - Repo: /tmp/widgets\n  - Context: Keep this detail")}`,
      ),
    ]);
  });

  test("edits the latest worker task-spec comment only in explicit correction mode", async () => {
    const recentTimestamp = new Date().toISOString();

    ghResults.push(
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: 501,
            body: renderWorkerTaskSpecComment("- Ship the change\n  - Type: Development task"),
            created_at: recentTimestamp,
            updated_at: recentTimestamp,
            user: { login: "codex" },
          },
        ]),
      },
      { exitCode: 0, stdout: "" },
    );

    const issueUrl = await createGitHubIssueTask(
      createTracker(),
      "planned",
      [
        "- Ship the change",
        "  - Type: Development task",
        "  - Context: Corrected detail",
      ],
      77,
      { commentMode: "correct-latest" },
    );

    expect(issueUrl).toBe("https://github.com/acme/widgets/issues/77");
    expect(ghCommands).toEqual([
      "gh label create workers:planned --repo acme/widgets --force --color D4C5F9 --description Workers planned queue",
      "gh label create workers:ready-to-be-picked-up --repo acme/widgets --force --color 0E8A16 --description Workers ready queue",
      "gh label create workers:in-progress --repo acme/widgets --force --color FBCA04 --description Workers in-progress queue",
      "gh issue edit 77 --repo acme/widgets --add-label workers:planned",
      "gh api repos/acme/widgets/issues/77/comments",
      normalizeCommand(
        `gh api repos/acme/widgets/issues/comments/501 --method PATCH -f body=${renderWorkerTaskSpecComment("- Ship the change\n  - Type: Development task\n  - Context: Corrected detail")}`,
      ),
    ]);
  });
});

describe("claimTaskFromTracker", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "workers-task-trackers-"));
    ghCommands.length = 0;
    ghResults.length = 0;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("claims from the latest structured worker task-spec comment and ignores unrelated discussion", async () => {
    ghResults.push(
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 42,
            title: "Original reporter title",
            body: "Original user-authored description.",
            createdAt: "2026-03-18T10:00:00Z",
          },
        ]),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: 11,
            body: "Can you clarify whether this should affect exports too?",
            created_at: "2026-03-18T11:00:00Z",
            updated_at: "2026-03-18T11:00:00Z",
            user: { login: "teammate" },
          },
          {
            id: 12,
            body: renderWorkerTaskSpecComment("- Older worker spec\n  - Agent: claude"),
            created_at: "2026-03-18T12:00:00Z",
            updated_at: "2026-03-18T12:00:00Z",
            user: { login: "codex" },
          },
          {
            id: 13,
            body: renderWorkerTaskSpecComment("- Latest worker spec\n  - Type: Development task\n  - Agent: codex"),
            created_at: "2026-03-18T13:00:00Z",
            updated_at: "2026-03-18T13:00:00Z",
            user: { login: "codex" },
          },
        ]),
      },
      { exitCode: 0, stdout: JSON.stringify([]) },
      { exitCode: 0, stdout: "" },
    );

    const result = await claimTaskFromTracker(
      createPollableTracker(),
      "codex",
      tempDir,
    );

    expect(result.status).toBe("claimed");
    expect(result.claimedTask?.summary).toBe("Latest worker spec");
    expect(result.claimedTask?.item).toBe("- Latest worker spec\n  - Type: Development task\n  - Agent: codex\n  - Repo: /tmp/widgets");
    expect(result.claimedTask?.localTodoContent).toContain("- Latest worker spec");
    expect(ghCommands).toEqual([
      "gh issue list --repo acme/widgets --state open --label workers:ready-to-be-picked-up --limit 100 --search sort:created-asc --json number,title,body,createdAt",
      "gh api repos/acme/widgets/issues/42/comments",
      "gh issue list --repo acme/widgets --state open --label workers:in-progress --limit 100 --search sort:created-asc --json number,title,body,createdAt",
      "gh label create workers:planned --repo acme/widgets --force --color D4C5F9 --description Workers planned queue",
      "gh label create workers:ready-to-be-picked-up --repo acme/widgets --force --color 0E8A16 --description Workers ready queue",
      "gh label create workers:in-progress --repo acme/widgets --force --color FBCA04 --description Workers in-progress queue",
      "gh issue edit 42 --repo acme/widgets --remove-label workers:ready-to-be-picked-up --add-label workers:in-progress",
    ]);
  });
});
