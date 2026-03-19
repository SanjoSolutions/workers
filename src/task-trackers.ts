import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { $ } from "zx";
import {
  claimFromTodoText,
  removeInProgressItemBySummary,
  todoContainsSummary,
  withTodoLock,
} from "./claim-todo.js";
import {
  fetchBranchTarget,
  resolveBranchTarget,
} from "./git-target.js";
import { resolveGitRepoRoot } from "./git-utils.js";
import type {
  PollableTaskTracker,
  ResolvedGitHubIssuesTaskTracker,
  ResolvedGitTodoTaskTracker,
} from "./task-tracker-settings.js";

interface GitTodoSyncState {
  kind: "git-todo";
  todoPath: string;
  repoRoot: string;
  todoRelativePath: string;
}

interface GitHubIssuesSyncState {
  kind: "github-issues";
  repository: string;
  issueNumber: number;
  labels: ResolvedGitHubIssuesTaskTracker["labels"];
}

type TaskSyncState = GitTodoSyncState | GitHubIssuesSyncState;

export interface ClaimedTask {
  trackerName: string;
  trackerKind: "git-todo" | "github-issues";
  trackerBasePath: string;
  item: string;
  itemType: string;
  itemAgent: string;
  summary: string;
  localTodoContent: string;
  syncState: TaskSyncState;
}

export interface ClaimTaskResult {
  status: "claimed" | "no-claim";
  reason: string;
  claimedTask?: ClaimedTask;
}

export interface CompletionSyncResult {
  status: "synced" | "pending";
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  createdAt?: string;
  taskSpecItem?: string;
}

interface GitHubIssueLabel {
  name: string;
}

interface GitHubIssueDetails {
  labels: GitHubIssueLabel[];
}

interface GitHubIssueComment {
  id: number;
  body: string;
  created_at?: string;
  updated_at?: string;
}

interface CreateGitHubIssueTaskOptions {
  commentMode?: "append" | "correct-latest";
}

const WORKER_TASK_SPEC_COMMENT_START = "<!-- workers-task-spec:v1 -->";
const WORKER_TASK_SPEC_COMMENT_END = "<!-- /workers-task-spec -->";
const COMMENT_CORRECTION_WINDOW_MS = 30 * 60 * 1000;

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end -= 1;
  }
  return lines.slice(0, end);
}

function filterGitHubIssueBodyLines(lines: string[]): string[] {
  return lines.filter((line) => !/^\s+- Repo:\s*.+$/i.test(line));
}

function normalizeGitHubIssueTaskItem(itemLines: string[]): string {
  return trimTrailingEmptyLines(itemLines.map((line) => line.replace(/\s+$/, ""))).join("\n");
}

function renderGitHubIssueTaskSpecComment(item: string): string {
  return [
    WORKER_TASK_SPEC_COMMENT_START,
    "```text",
    item,
    "```",
    WORKER_TASK_SPEC_COMMENT_END,
  ].join("\n");
}

function parseGitHubIssueTaskSpecComment(body: string): string | null {
  const match = body.match(
    /<!-- workers-task-spec:v1 -->\s*```(?:text)?\s*([\s\S]*?)\s*```\s*<!-- \/workers-task-spec -->/i,
  );
  if (!match) {
    return null;
  }

  const item = match[1].trim();
  return item ? item : null;
}

function parseGitHubIssueNumber(issueUrl: string): number | null {
  const match = issueUrl.trim().match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function compareGitHubIssueComments(
  left: GitHubIssueComment,
  right: GitHubIssueComment,
): number {
  const leftTime = Date.parse(left.created_at ?? left.updated_at ?? "") || 0;
  const rightTime = Date.parse(right.created_at ?? right.updated_at ?? "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.id - right.id;
}

function findEditableGitHubTaskSpecComment(
  comments: GitHubIssueComment[],
): GitHubIssueComment | null {
  if (comments.length === 0) {
    return null;
  }

  const sortedComments = [...comments].sort(compareGitHubIssueComments);
  const latestComment = sortedComments[sortedComments.length - 1];
  if (!parseGitHubIssueTaskSpecComment(latestComment.body)) {
    return null;
  }

  const referenceTimestamp = latestComment.updated_at ?? latestComment.created_at;
  if (!referenceTimestamp) {
    return null;
  }

  const ageMs = Date.now() - Date.parse(referenceTimestamp);
  return ageMs <= COMMENT_CORRECTION_WINDOW_MS ? latestComment : null;
}

async function listGitHubIssueComments(
  repository: string,
  issueNumber: number,
): Promise<GitHubIssueComment[]> {
  const result =
    await $`gh api repos/${repository}/issues/${String(issueNumber)}/comments`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to list comments for GitHub issue #${issueNumber} in ${repository}.`,
    );
  }

  return JSON.parse(result.stdout) as GitHubIssueComment[];
}

export async function loadGitHubIssueTaskSpecItem(
  repository: string,
  issueNumber: number,
): Promise<string | undefined> {
  const comments = await listGitHubIssueComments(repository, issueNumber);
  const taskSpecComments = comments
    .sort(compareGitHubIssueComments)
    .map((comment) => parseGitHubIssueTaskSpecComment(comment.body))
    .filter((item): item is string => item !== null);

  return taskSpecComments[taskSpecComments.length - 1];
}

async function attachGitHubIssueTaskSpecs(
  tracker: ResolvedGitHubIssuesTaskTracker,
  issues: GitHubIssue[],
): Promise<GitHubIssue[]> {
  return Promise.all(issues.map(async (issue) => ({
    ...issue,
    taskSpecItem: await loadGitHubIssueTaskSpecItem(
      tracker.repository,
      issue.number,
    ),
  })));
}

async function publishGitHubIssueTaskSpecComment(
  repository: string,
  issueNumber: number,
  item: string,
  options: CreateGitHubIssueTaskOptions = {},
): Promise<void> {
  const commentBody = renderGitHubIssueTaskSpecComment(item);

  if (options.commentMode === "correct-latest") {
    const comments = await listGitHubIssueComments(repository, issueNumber);
    const editableComment = findEditableGitHubTaskSpecComment(comments);
    if (editableComment) {
      const patchResult =
        await $`gh api repos/${repository}/issues/comments/${String(editableComment.id)} --method PATCH -f body=${commentBody}`
          .quiet()
          .nothrow();
      if (patchResult.exitCode !== 0) {
        throw new Error(
          `Failed to update worker task spec comment for GitHub issue #${issueNumber} in ${repository}.`,
        );
      }
      return;
    }
  }

  const createResult =
    await $`gh api repos/${repository}/issues/${String(issueNumber)}/comments --method POST -f body=${commentBody}`
      .quiet()
      .nothrow();
  if (createResult.exitCode !== 0) {
    throw new Error(
      `Failed to create worker task spec comment for GitHub issue #${issueNumber} in ${repository}.`,
    );
  }
}

function renderIssueItem(issue: GitHubIssue): string {
  if (issue.taskSpecItem) {
    return issue.taskSpecItem;
  }

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


export async function fastForwardRepo(repoRoot: string): Promise<boolean> {
  const branchTarget = await resolveBranchTarget(repoRoot);
  if (!branchTarget.hasRemote) {
    return true;
  }

  const fetchResult = await fetchBranchTarget(repoRoot, branchTarget);
  if (!fetchResult) {
    return false;
  }

  const pullResult =
    await $`git -C ${repoRoot} pull --ff-only ${branchTarget.remoteName!} ${branchTarget.remoteBranch!}`
      .quiet()
      .nothrow();
  return pullResult.exitCode === 0;
}

export async function commitAndPushTodoRepo(
  repoRoot: string,
  todoRelativePath: string,
  message: string,
): Promise<boolean> {
  const branchTarget = await resolveBranchTarget(repoRoot);
  const branch = branchTarget.branch;

  const addResult =
    await $`git -C ${repoRoot} add ${todoRelativePath}`.quiet().nothrow();
  if (addResult.exitCode !== 0) {
    return false;
  }

  const stagedResult =
    await $`git -C ${repoRoot} diff --cached --quiet -- ${todoRelativePath}`
      .quiet()
      .nothrow();
  if (stagedResult.exitCode === 0) {
    return true;
  }

  const commitResult =
    await $`git -C ${repoRoot} commit -m ${message}`.quiet().nothrow();
  if (commitResult.exitCode !== 0) {
    return false;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!branchTarget.hasRemote) {
      return true;
    }

    const pushResult =
      await $`git -C ${repoRoot} push ${branchTarget.remoteName!} HEAD:${branch}`.quiet().nothrow();
    if (pushResult.exitCode === 0) {
      return true;
    }

    const rebaseResult =
      await $`git -C ${repoRoot} pull --rebase ${branchTarget.remoteName!} ${branch}`
        .quiet()
        .nothrow();
    if (rebaseResult.exitCode !== 0) {
      return false;
    }
  }

  return false;
}

async function ensureGitHubLabels(
  tracker: ResolvedGitHubIssuesTaskTracker,
): Promise<void> {
  const labelMetadata = [
    {
      name: tracker.labels.planned,
      color: "D4C5F9",
      description: "Workers planned queue",
    },
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

async function listGitHubIssues(
  tracker: ResolvedGitHubIssuesTaskTracker,
  label: string,
): Promise<GitHubIssue[]> {
  const result =
    await $`gh issue list --repo ${tracker.repository} --state open --label ${label} --limit 100 --search ${"sort:created-asc"} --json number,title,body,createdAt`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to list GitHub issues for ${tracker.repository} with label "${label}".`,
    );
  }

  const parsed = JSON.parse(result.stdout) as GitHubIssue[];
  const sortedIssues = parsed.sort((left, right) => {
    return (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
  });
  return attachGitHubIssueTaskSpecs(tracker, sortedIssues);
}

async function removeGitHubIssueLabelsIfPresent(
  repository: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  const issueResult =
    await $`gh issue view ${String(issueNumber)} --repo ${repository} --json labels`
      .quiet()
      .nothrow();
  if (issueResult.exitCode !== 0) {
    throw new Error(
      `Failed to inspect GitHub issue #${issueNumber} in ${repository}.`,
    );
  }

  const issue = JSON.parse(issueResult.stdout) as GitHubIssueDetails;
  const existingLabels = new Set(issue.labels.map((label) => label.name));

  for (const label of labels) {
    if (!existingLabels.has(label)) {
      continue;
    }

    const editResult =
      await $`gh issue edit ${String(issueNumber)} --repo ${repository} --remove-label ${label}`
        .quiet()
        .nothrow();
    if (editResult.exitCode !== 0) {
      throw new Error(
        `Failed to remove label "${label}" from GitHub issue #${issueNumber} in ${repository}.`,
      );
    }
  }
}

async function claimTaskFromGitTodoTracker(
  tracker: ResolvedGitTodoTaskTracker,
  cli: string,
): Promise<ClaimTaskResult> {
  const repoRoot = await resolveGitRepoRoot(tracker.repo);
  const todoPath = path.resolve(repoRoot, tracker.file);
  const todoRelativePath = path.relative(repoRoot, todoPath);

  if (!(await fastForwardRepo(repoRoot))) {
    throw new Error(`Failed to sync task tracker ${tracker.name}.`);
  }

  const content = readFileSync(todoPath, "utf8");
  const selection = claimFromTodoText(content, { agent: cli });
  if (selection.status !== "claimed") {
    return {
      status: "no-claim",
      reason: selection.reason,
    };
  }

  const pushed = await withTodoLock(todoPath, async () => {
    const lockedContent = readFileSync(todoPath, "utf8");
    const claimResult = claimFromTodoText(lockedContent, { agent: cli });
    if (claimResult.status !== "claimed") {
      return false;
    }

    writeFileSync(todoPath, claimResult.updatedContent, "utf8");
    const claimSummary = claimResult.item.split("\n")[0].replace(/^- /, "");
    return commitAndPushTodoRepo(
      repoRoot,
      todoRelativePath,
      `chore(todo): claim TODO — ${claimSummary}`,
    );
  });

  if (!pushed) {
    throw new Error(`Failed to commit/push claimed TODO in ${tracker.name}.`);
  }

  const claimedContent = readFileSync(todoPath, "utf8");
  const summary = selection.item.split("\n")[0].replace(/^- /, "");

  return {
    status: "claimed",
    reason: "claimed",
    claimedTask: {
      trackerName: tracker.name,
      trackerKind: "git-todo",
      trackerBasePath: repoRoot,
      item: selection.item,
      itemType: selection.itemType,
      itemAgent: selection.itemAgent,
      summary,
      localTodoContent: claimedContent,
      syncState: {
        kind: "git-todo",
        todoPath,
        repoRoot,
        todoRelativePath,
      },
    },
  };
}

async function claimTaskFromGitHubIssuesTracker(
  tracker: ResolvedGitHubIssuesTaskTracker,
  cli: string,
  invocationPath: string,
): Promise<ClaimTaskResult> {
  const readyIssues = await listGitHubIssues(tracker, tracker.labels.ready);
  if (readyIssues.length === 0) {
    return {
      status: "no-claim",
      reason: "ready-empty",
    };
  }

  const inProgressIssues = await listGitHubIssues(tracker, tracker.labels.inProgress);
  const syntheticTodo = renderTodoFromIssues(inProgressIssues, readyIssues);
  const selection = claimFromTodoText(syntheticTodo, { agent: cli });
  if (selection.status !== "claimed") {
    return {
      status: "no-claim",
      reason: selection.reason,
    };
  }

  const summary = selection.item.split("\n")[0].replace(/^- /, "");
  const selectedIssue = readyIssues.find((issue) => renderIssueItem(issue) === selection.item);
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

export async function claimTaskFromTracker(
  pollableTracker: PollableTaskTracker,
  cli: string,
  invocationPath: string,
): Promise<ClaimTaskResult> {
  return pollableTracker.tracker.kind === "github-issues"
    ? claimTaskFromGitHubIssuesTracker(pollableTracker.tracker, cli, invocationPath)
    : claimTaskFromGitTodoTracker(pollableTracker.tracker, cli);
}

export function syncClaimedTaskToLocal(
  claimedTask: ClaimedTask,
  localTodoPath: string,
): void {
  mkdirSync(path.dirname(localTodoPath), { recursive: true });
  writeFileSync(localTodoPath, claimedTask.localTodoContent, "utf8");
}

export async function syncCompletedTask(
  claimedTask: ClaimedTask,
  localTodoPath: string,
): Promise<CompletionSyncResult> {
  const localTodoContent = readFileSync(localTodoPath, "utf8");
  if (todoContainsSummary(localTodoContent, claimedTask.summary)) {
    return {
      status: "pending",
    };
  }

  const syncState = claimedTask.syncState;

  if (syncState.kind === "git-todo") {
    const syncedCompletion = await withTodoLock(
      syncState.todoPath,
      async () => {
        const sharedContent = readFileSync(syncState.todoPath, "utf8");
        const removal = removeInProgressItemBySummary(sharedContent, claimedTask.summary);
        if (removal.status !== "removed") {
          return true;
        }

        writeFileSync(syncState.todoPath, removal.updatedContent, "utf8");
        return commitAndPushTodoRepo(
          syncState.repoRoot,
          syncState.todoRelativePath,
          `chore(todo): complete TODO — ${claimedTask.summary}`,
        );
      },
    );

    if (!syncedCompletion) {
      throw new Error(
        `Failed to commit/push completed TODO in ${claimedTask.trackerName}.`,
      );
    }

    writeFileSync(localTodoPath, readFileSync(syncState.todoPath, "utf8"), "utf8");
    return {
      status: "synced",
    };
  }

  await removeGitHubIssueLabelsIfPresent(
    syncState.repository,
    syncState.issueNumber,
    [syncState.labels.ready, syncState.labels.inProgress],
  );

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
  options: CreateGitHubIssueTaskOptions = {},
): Promise<string> {
  await ensureGitHubLabels(tracker);

  const title = itemLines[0].replace(/^- /, "").trim();
  const normalizedItem = normalizeGitHubIssueTaskItem(itemLines);
  const body = filterGitHubIssueBodyLines(itemLines.slice(1)).join("\n").trim();
  const label = section === "ready" ? tracker.labels.ready : tracker.labels.planned;

  if (issueNumber !== undefined) {
    const editResult =
      await $`gh issue edit ${String(issueNumber)} --repo ${tracker.repository} --add-label ${label}`
        .quiet()
        .nothrow();
    if (editResult.exitCode !== 0) {
      throw new Error(
        `Failed to update GitHub issue #${issueNumber} in ${tracker.repository}.`,
      );
    }

    await publishGitHubIssueTaskSpecComment(
      tracker.repository,
      issueNumber,
      normalizedItem,
      options,
    );

    return `https://github.com/${tracker.repository}/issues/${issueNumber}`;
  }

  const result =
    await $`gh issue create --repo ${tracker.repository} --title ${title} --body ${body} --label ${label}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create GitHub issue in ${tracker.repository}.`);
  }

  const issueUrl = result.stdout.trim();
  const createdIssueNumber = parseGitHubIssueNumber(issueUrl);
  if (createdIssueNumber === null) {
    throw new Error(
      `Failed to determine GitHub issue number from "${issueUrl}" in ${tracker.repository}.`,
    );
  }

  await publishGitHubIssueTaskSpecComment(
    tracker.repository,
    createdIssueNumber,
    normalizedItem,
    options,
  );

  return issueUrl;
}
