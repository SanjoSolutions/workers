import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ResolvedGitHubIssuesTaskTracker } from "./task-tracker-settings.js";

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

const { createGitHubIssueTask } = await import("../build/task-trackers.js");

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
    },
    claimComment: {
      message: "I will work on this.",
    },
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

describe("built createGitHubIssueTask", () => {
  beforeEach(() => {
    ghCommands.length = 0;
    ghResults.length = 0;
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
});
