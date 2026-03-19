import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  PollableTaskTracker,
  ResolvedGitHubIssuesTaskTracker,
} from "./task-tracker-settings.js";
import type { ClaimedTask, GitHubIssue } from "./task-trackers.js";
import type { GitHubIssueComment } from "./task-trackers/github-issues/index.js";

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
  getGitHubIssueSection,
  partitionGitHubIssuesBySection,
  syncCompletedTask,
} = await import("./task-trackers.js");
const {
  parseGitHubIssueClaimComment,
  renderGitHubIssueClaimComment,
  selectWinningGitHubIssueClaimComment,
} = await import("./task-trackers/github-issues/index.js");

function createTracker(): ResolvedGitHubIssuesTaskTracker {
  return {
    name: "demo",
    kind: "github-issues",
    repository: "acme/widgets",
    defaultRepo: "/tmp/widgets",
    tokenCommand: undefined,
    githubApp: undefined,
    labels: {
      ready: "workers:ready-to-be-picked-up",
      inProgress: "workers:in-progress",
      prReady: "workers:pr-ready",
    },
    claimComment: {
      message: "I will work on this.",
    },
  };
}

function createPollableTracker(): PollableTaskTracker {
  return {
    tracker: createTracker(),
    source: "project",
  };
}

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

const TRACKER: ResolvedGitHubIssuesTaskTracker = {
  name: "workers",
  kind: "github-issues",
  repository: "SanjoSolutions/workers",
  defaultRepo: "/home/jonas/workers",
  tokenCommand: undefined,
  githubApp: undefined,
  labels: {
    ready: "workers:ready-to-be-picked-up",
    inProgress: "workers:in-progress",
    prReady: "workers:pr-ready",
  },
  claimComment: {
    message: "I will work on this.",
  },
};

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

  test("leaves GitHub issues open when a completed task syncs", async () => {
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
          ready: "workers:ready-to-be-picked-up",
          inProgress: "workers:in-progress",
          prReady: "workers:pr-ready",
        },
      },
    };

    const result = await syncCompletedTask(claimedTask, localTodoPath);

    expect(result).toEqual({ status: "synced" });
    expect(ghCommands).toEqual([]);
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
      "gh label create workers:ready-to-be-picked-up --repo acme/widgets --force --color 0E8A16 --description Workers ready queue",
      "gh label create workers:in-progress --repo acme/widgets --force --color FBCA04 --description Workers in-progress queue",
      "gh label create workers:pr-ready --repo acme/widgets --force --color 5319E7 --description Workers pull request ready queue",
      "gh issue create --repo acme/widgets --title Ship the change --body - Type: Development task - Context: Keep this detail --label workers:ready-to-be-picked-up",
      normalizeCommand(
        `gh api repos/acme/widgets/issues/77/comments --method POST --field body=${renderWorkerTaskSpecComment("- Ship the change\n  - Type: Development task\n  - Repo: /tmp/widgets\n  - Context: Keep this detail")}`,
      ),
    ]);
  });

  test("preserves an existing issue title and body and appends a structured worker comment", async () => {
    ghResults.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 77,
          title: "Ship the change",
          body: "Existing user-authored context.",
          labels: [],
        }),
      },
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
      "gh issue view 77 --repo acme/widgets --json number,title,body,createdAt,labels",
      normalizeCommand(
        `gh api repos/acme/widgets/issues/77/comments --method POST --field body=${renderWorkerTaskSpecComment("- Ship the change\n  - Type: Development task\n  - Repo: /tmp/widgets\n  - Context: Keep this detail")}`,
      ),
    ]);
  });

  test("edits the latest worker task-spec comment only in explicit correction mode", async () => {
    const recentTimestamp = new Date().toISOString();

    ghResults.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          number: 77,
          title: "Ship the change",
          body: "Existing user-authored context.",
          labels: [],
        }),
      },
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
      "gh issue view 77 --repo acme/widgets --json number,title,body,createdAt,labels",
      "gh api repos/acme/widgets/issues/77/comments?per_page=100",
      normalizeCommand(
        `gh api repos/acme/widgets/issues/comments/501 --method PATCH --field body=${renderWorkerTaskSpecComment("- Ship the change\n  - Type: Development task\n  - Context: Corrected detail")}`,
      ),
    ]);
  });

  test("treats unlabeled open issues as planned work", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "Unlabeled backlog item",
      body: "",
      labels: [],
    };

    expect(getGitHubIssueSection(issue, TRACKER)).toBe("planned");
  });

  test("prefers the in-progress label when multiple workflow labels are present", () => {
    const issue: GitHubIssue = {
      number: 2,
      title: "Conflicting labels",
      body: "",
      labels: [
        { name: TRACKER.labels.ready },
        { name: TRACKER.labels.inProgress },
      ],
    };

    expect(getGitHubIssueSection(issue, TRACKER)).toBe("in-progress");
  });

  test("partitions open issues into planned, ready, and in-progress sections", () => {
    const issues: GitHubIssue[] = [
      {
        number: 3,
        title: "Ready item",
        body: "",
        createdAt: "2026-03-19T09:00:00Z",
        labels: [{ name: TRACKER.labels.ready }],
      },
      {
        number: 4,
        title: "Backlog item",
        body: "",
        createdAt: "2026-03-19T08:00:00Z",
        labels: [],
      },
      {
        number: 5,
        title: "Claimed item",
        body: "",
        createdAt: "2026-03-19T10:00:00Z",
        labels: [{ name: TRACKER.labels.inProgress }],
      },
    ];

    const sections = partitionGitHubIssuesBySection(issues, TRACKER);

    expect(sections.planned.map((issue) => issue.title)).toEqual(["Backlog item"]);
    expect(sections.ready.map((issue) => issue.title)).toEqual(["Ready item"]);
    expect(sections["in-progress"].map((issue) => issue.title)).toEqual(["Claimed item"]);
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
            labels: [{ name: "workers:ready-to-be-picked-up" }],
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
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          id: 99,
          body: renderGitHubIssueClaimComment("I will work on this.", {
            sessionId: "codex-session",
            cli: "codex",
            trackerName: "demo",
            repository: "acme/widgets",
            issueNumber: 42,
            claimedAt: "2026-03-19T10:00:00.000Z",
          }),
          created_at: "2026-03-19T10:00:00.000Z",
          updated_at: "2026-03-19T10:00:00.000Z",
          user: { login: "codex" },
        }),
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
        ]),
      },
      { exitCode: 0, stdout: "" },
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
        ]),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 42,
            title: "Original reporter title",
            body: "Original user-authored description.",
            createdAt: "2026-03-18T10:00:00Z",
            labels: [{ name: "workers:in-progress" }],
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
            id: 13,
            body: renderWorkerTaskSpecComment("- Latest worker spec\n  - Type: Development task\n  - Agent: codex"),
            created_at: "2026-03-18T13:00:00Z",
            updated_at: "2026-03-18T13:00:00Z",
            user: { login: "codex" },
          },
        ]),
      },
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
    expect(ghCommands).toHaveLength(11);
    expect(ghCommands.slice(0, 5)).toEqual([
      "gh issue list --repo acme/widgets --state open --limit 100 --search sort:created-asc --json number,title,body,createdAt,labels",
      "gh api repos/acme/widgets/issues/42/comments?per_page=100",
      "gh label create workers:ready-to-be-picked-up --repo acme/widgets --force --color 0E8A16 --description Workers ready queue",
      "gh label create workers:in-progress --repo acme/widgets --force --color FBCA04 --description Workers in-progress queue",
      "gh label create workers:pr-ready --repo acme/widgets --force --color 5319E7 --description Workers pull request ready queue",
    ]);
    expect(ghCommands[5]).toMatch(
      /^gh api repos\/acme\/widgets\/issues\/42\/comments --method POST --field body=/,
    );
    expect(ghCommands.slice(6)).toEqual([
      "gh api repos/acme/widgets/issues/42/comments?per_page=100",
      "gh issue edit 42 --repo acme/widgets --remove-label workers:ready-to-be-picked-up --add-label workers:in-progress",
      "gh api repos/acme/widgets/issues/42/comments?per_page=100",
      "gh issue list --repo acme/widgets --state open --limit 100 --search sort:created-asc --json number,title,body,createdAt,labels",
      "gh api repos/acme/widgets/issues/42/comments?per_page=100",
    ]);
  });

  test("matches a ready issue even when the task spec comment uses CRLF line endings", async () => {
    ghResults.push(
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 29,
            title: "Original reporter title",
            body: "Original user-authored description.",
            createdAt: "2026-03-18T10:00:00Z",
            labels: [{ name: "workers:ready-to-be-picked-up" }],
          },
        ]),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: 21,
            body: renderWorkerTaskSpecComment("- Move the TODO repo template into `todos-repo-template`\r\n  - Type: Development task"),
            created_at: "2026-03-18T13:00:00Z",
            updated_at: "2026-03-18T13:00:00Z",
            user: { login: "codex" },
          },
        ]),
      },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          id: 99,
          body: renderGitHubIssueClaimComment("I will work on this.", {
            sessionId: "codex-session",
            cli: "codex",
            trackerName: "demo",
            repository: "acme/widgets",
            issueNumber: 29,
            claimedAt: "2026-03-19T10:00:00.000Z",
          }),
          created_at: "2026-03-19T10:00:00.000Z",
          updated_at: "2026-03-19T10:00:00.000Z",
          user: { login: "codex" },
        }),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: 99,
            body: renderGitHubIssueClaimComment("I will work on this.", {
              sessionId: "codex-session",
              cli: "codex",
              trackerName: "demo",
              repository: "acme/widgets",
              issueNumber: 29,
              claimedAt: "2026-03-19T10:00:00.000Z",
            }),
            created_at: "2026-03-19T10:00:00.000Z",
            updated_at: "2026-03-19T10:00:00.000Z",
            user: { login: "codex" },
          },
        ]),
      },
      { exitCode: 0, stdout: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            number: 29,
            title: "Original reporter title",
            body: "Original user-authored description.",
            createdAt: "2026-03-18T10:00:00Z",
            labels: [{ name: "workers:in-progress" }],
          },
        ]),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: 21,
            body: renderWorkerTaskSpecComment("- Move the TODO repo template into `todos-repo-template`\r\n  - Type: Development task"),
            created_at: "2026-03-18T13:00:00Z",
            updated_at: "2026-03-18T13:00:00Z",
            user: { login: "codex" },
          },
          {
            id: 99,
            body: renderGitHubIssueClaimComment("I will work on this.", {
              sessionId: "codex-session",
              cli: "codex",
              trackerName: "demo",
              repository: "acme/widgets",
              issueNumber: 29,
              claimedAt: "2026-03-19T10:00:00.000Z",
            }),
            created_at: "2026-03-19T10:00:00.000Z",
            updated_at: "2026-03-19T10:00:00.000Z",
            user: { login: "codex" },
          },
        ]),
      },
    );

    const result = await claimTaskFromTracker(
      createPollableTracker(),
      "codex",
      tempDir,
    );

    expect(result.status).toBe("claimed");
    expect(result.claimedTask?.summary).toBe("Move the TODO repo template into `todos-repo-template`");
  });
});

describe("GitHub issue claim comments", () => {
  test("renders a human-readable claim comment with structured metadata", () => {
    const body = renderGitHubIssueClaimComment("I will work on this.", {
      sessionId: "codex-claim-session",
      cli: "codex",
      trackerName: "workers",
      repository: "SanjoSolutions/workers",
      issueNumber: 42,
      claimedAt: "2026-03-19T10:00:00.000Z",
    });

    expect(body.startsWith("I will work on this.")).toBe(true);
    expect(body).toContain("```workers-issue-claim");

    expect(parseGitHubIssueClaimComment(body)).toEqual({
      message: "I will work on this.",
      metadata: {
        type: "workers-issue-claim",
        version: 1,
        sessionId: "codex-claim-session",
        cli: "codex",
        trackerName: "workers",
        repository: "SanjoSolutions/workers",
        issueNumber: 42,
        claimedAt: "2026-03-19T10:00:00.000Z",
      },
    });
  });

  test("deterministically selects the earliest structured claim comment during a race", () => {
    const comments: GitHubIssueComment[] = [
      {
        id: 18,
        body: "Looks good to me.",
        createdAt: "2026-03-19T10:00:02.000Z",
      },
      {
        id: 21,
        body: renderGitHubIssueClaimComment("I will work on this.", {
          sessionId: "codex-session-two",
          cli: "codex",
          trackerName: "workers",
          repository: "SanjoSolutions/workers",
          issueNumber: 42,
          claimedAt: "2026-03-19T10:00:04.000Z",
        }),
        createdAt: "2026-03-19T10:00:04.000Z",
      },
      {
        id: 20,
        body: renderGitHubIssueClaimComment("I will work on this.", {
          sessionId: "codex-session-one",
          cli: "codex",
          trackerName: "workers",
          repository: "SanjoSolutions/workers",
          issueNumber: 42,
          claimedAt: "2026-03-19T10:00:03.000Z",
        }),
        createdAt: "2026-03-19T10:00:03.000Z",
      },
    ];

    expect(selectWinningGitHubIssueClaimComment(comments)).toMatchObject({
      id: 20,
      metadata: {
        sessionId: "codex-session-one",
      },
    });
  });
});
