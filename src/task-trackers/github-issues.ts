import { $ } from "zx";
import { claimFromTodoText } from "../claim-todo.js";
import type {
  PollableTaskTracker,
  ResolvedGitHubIssuesTaskTracker,
} from "../task-tracker-settings.js";
import type {
  ClaimTaskResult,
  ClaimedTask,
  CompletionSyncResult,
  GitHubIssue,
  GitHubIssueSection,
} from "./types.js";

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end -= 1;
  }
  return lines.slice(0, end);
}

function renderIssueItem(issue: GitHubIssue): string {
  const bodyLines = trimTrailingEmptyLines(
    issue.body
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/, "")),
  ).filter((line, index, lines) => {
    if (line !== "") {
      return true;
    }
    return index > 0 && index < lines.length - 1;
  });

  return [`- ${issue.title}`, ...bodyLines].join("\n");
}

function renderTodoFromIssues(
  inProgressIssues: GitHubIssue[],
  readyIssues: GitHubIssue[],
): string {
  const sections = [
    "# TODOs",
    "",
    "## In progress",
    "",
    ...inProgressIssues.flatMap((issue) => [renderIssueItem(issue), ""]),
    "## Ready to be picked up",
    "",
    ...readyIssues.flatMap((issue) => [renderIssueItem(issue), ""]),
  ];

  return `${sections.join("\n").trimEnd()}\n`;
}

function sortGitHubIssuesByCreatedAt(issues: GitHubIssue[]): GitHubIssue[] {
  return [...issues].sort((left, right) => {
    return (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
  });
}

function hasGitHubIssueLabel(issue: GitHubIssue, labelName: string): boolean {
  return (issue.labels ?? []).some((label) => label.name === labelName);
}

export function getGitHubIssueSection(
  issue: GitHubIssue,
  tracker: ResolvedGitHubIssuesTaskTracker,
): GitHubIssueSection {
  if (hasGitHubIssueLabel(issue, tracker.labels.inProgress)) {
    return "in-progress";
  }
  if (hasGitHubIssueLabel(issue, tracker.labels.ready)) {
    return "ready";
  }
  return "planned";
}

export function partitionGitHubIssuesBySection(
  issues: GitHubIssue[],
  tracker: ResolvedGitHubIssuesTaskTracker,
): Record<GitHubIssueSection, GitHubIssue[]> {
  const sections: Record<GitHubIssueSection, GitHubIssue[]> = {
    "in-progress": [],
    ready: [],
    planned: [],
  };

  for (const issue of sortGitHubIssuesByCreatedAt(issues)) {
    sections[getGitHubIssueSection(issue, tracker)].push(issue);
  }

  return sections;
}

async function ensureGitHubLabels(
  tracker: ResolvedGitHubIssuesTaskTracker,
): Promise<void> {
  const labelMetadata = [
    {
      name: tracker.labels.ready,
      color: "0E8A16",
      description: "Workers ready queue",
    },
    {
      name: tracker.labels.inProgress,
      color: "FBCA04",
      description: "Workers in-progress queue",
    },
  ];

  for (const label of labelMetadata) {
    const result =
      await $`gh label create ${label.name} --repo ${tracker.repository} --force --color ${label.color} --description ${label.description}`
        .quiet()
        .nothrow();
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to ensure GitHub label "${label.name}" in ${tracker.repository}.`,
      );
    }
  }
}

export async function listOpenGitHubIssues(
  tracker: ResolvedGitHubIssuesTaskTracker,
): Promise<GitHubIssue[]> {
  const result =
    await $`gh issue list --repo ${tracker.repository} --state open --limit 100 --search ${"sort:created-asc"} --json number,title,body,createdAt,labels`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to list open GitHub issues for ${tracker.repository}.`,
    );
  }

  return sortGitHubIssuesByCreatedAt(JSON.parse(result.stdout) as GitHubIssue[]);
}

async function getGitHubIssue(
  tracker: ResolvedGitHubIssuesTaskTracker,
  issueNumber: number,
): Promise<GitHubIssue> {
  const result =
    await $`gh issue view ${String(issueNumber)} --repo ${tracker.repository} --json number,title,body,createdAt,labels`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to load GitHub issue #${issueNumber} in ${tracker.repository}.`,
    );
  }

  return JSON.parse(result.stdout) as GitHubIssue;
}

export async function claimTaskFromGitHubIssuesTracker(
  tracker: ResolvedGitHubIssuesTaskTracker,
  cli: string,
  invocationPath: string,
): Promise<ClaimTaskResult> {
  const openIssues = await listOpenGitHubIssues(tracker);
  const issuesBySection = partitionGitHubIssuesBySection(openIssues, tracker);
  const readyIssues = issuesBySection.ready;
  if (readyIssues.length === 0) {
    return {
      status: "no-claim",
      reason: "ready-empty",
    };
  }

  const inProgressIssues = issuesBySection["in-progress"];
  const syntheticTodo = renderTodoFromIssues(inProgressIssues, readyIssues);
  const selection = claimFromTodoText(syntheticTodo, { agent: cli });
  if (selection.status !== "claimed") {
    return {
      status: "no-claim",
      reason: selection.reason,
    };
  }

  const summary = selection.item.split("\n")[0].replace(/^- /, "");
  const selectedIssue = readyIssues.find((issue) => issue.title === summary);
  if (!selectedIssue) {
    throw new Error(
      `Failed to resolve claimed GitHub issue for "${summary}" in ${tracker.repository}.`,
    );
  }

  await ensureGitHubLabels(tracker);
  const editResult =
    await $`gh issue edit ${String(selectedIssue.number)} --repo ${tracker.repository} --remove-label ${tracker.labels.ready} --add-label ${tracker.labels.inProgress}`
      .quiet()
      .nothrow();
  if (editResult.exitCode !== 0) {
    throw new Error(
      `Failed to claim GitHub issue #${selectedIssue.number} in ${tracker.repository}.`,
    );
  }

  const localTodoContent = renderTodoFromIssues(
    [...inProgressIssues, selectedIssue],
    readyIssues.filter((issue) => issue.number !== selectedIssue.number),
  );

  let claimedItem = selection.item;
  if (tracker.defaultRepo && !claimedItem.includes("- Repo:")) {
    claimedItem += `\n  - Repo: ${tracker.defaultRepo}`;
  }

  return {
    status: "claimed",
    reason: "claimed",
    claimedTask: {
      trackerName: tracker.name,
      trackerKind: "github-issues",
      trackerBasePath: tracker.defaultRepo || invocationPath,
      item: claimedItem,
      itemType: selection.itemType,
      itemAgent: selection.itemAgent,
      summary,
      localTodoContent,
      syncState: {
        kind: "github-issues",
        repository: tracker.repository,
        issueNumber: selectedIssue.number,
        labels: tracker.labels,
      },
    },
  };
}

export async function syncCompletedGitHubIssueTask(
  claimedTask: ClaimedTask,
): Promise<CompletionSyncResult> {
  const syncState = claimedTask.syncState;
  if (syncState.kind !== "github-issues") {
    throw new Error(`Expected github-issues sync state for ${claimedTask.summary}.`);
  }

  const closeResult =
    await $`gh issue close ${String(syncState.issueNumber)} --repo ${syncState.repository} --reason completed`
      .quiet()
      .nothrow();
  if (closeResult.exitCode !== 0) {
    throw new Error(
      `Failed to close GitHub issue #${syncState.issueNumber} in ${syncState.repository}.`,
    );
  }

  return {
    status: "synced",
  };
}

export async function createGitHubIssueTask(
  tracker: ResolvedGitHubIssuesTaskTracker,
  section: "planned" | "ready",
  itemLines: string[],
  issueNumber?: number,
): Promise<string> {
  const title = itemLines[0].replace(/^- /, "").trim();
  const body = itemLines.slice(1).join("\n").trim();

  if (issueNumber !== undefined) {
    const issue = await getGitHubIssue(tracker, issueNumber);
    const editResult =
      await $`gh issue edit ${String(issueNumber)} --repo ${tracker.repository} --title ${title} --body ${body}`
        .quiet()
        .nothrow();
    if (editResult.exitCode !== 0) {
      throw new Error(
        `Failed to update GitHub issue #${issueNumber} in ${tracker.repository}.`,
      );
    }

    const labelsToRemove = [tracker.labels.ready, tracker.labels.inProgress].filter(
      (label) => hasGitHubIssueLabel(issue, label),
    );
    for (const label of labelsToRemove) {
      if (section === "ready" && label === tracker.labels.ready) {
        continue;
      }

      const removeResult =
        await $`gh issue edit ${String(issueNumber)} --repo ${tracker.repository} --remove-label ${label}`
          .quiet()
          .nothrow();
      if (removeResult.exitCode !== 0) {
        throw new Error(
          `Failed to remove GitHub label "${label}" from issue #${issueNumber} in ${tracker.repository}.`,
        );
      }
    }

    if (section === "ready" && !hasGitHubIssueLabel(issue, tracker.labels.ready)) {
      await ensureGitHubLabels(tracker);
      const addResult =
        await $`gh issue edit ${String(issueNumber)} --repo ${tracker.repository} --add-label ${tracker.labels.ready}`
          .quiet()
          .nothrow();
      if (addResult.exitCode !== 0) {
        throw new Error(
          `Failed to add GitHub label "${tracker.labels.ready}" to issue #${issueNumber} in ${tracker.repository}.`,
        );
      }
    }

    return `https://github.com/${tracker.repository}/issues/${issueNumber}`;
  }

  if (section === "ready") {
    await ensureGitHubLabels(tracker);
  }

  const result =
    section === "ready"
      ? await $`gh issue create --repo ${tracker.repository} --title ${title} --body ${body} --label ${tracker.labels.ready}`
        .quiet()
        .nothrow()
      : await $`gh issue create --repo ${tracker.repository} --title ${title} --body ${body}`
        .quiet()
        .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create GitHub issue in ${tracker.repository}.`);
  }

  return result.stdout.trim();
}
