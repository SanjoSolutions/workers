import { randomUUID } from "crypto";
import { $ } from "zx";
import { claimFromTodoText } from "../../claim-todo.js";
import type {
  PollableTaskTracker,
  ResolvedGitHubIssuesTaskTracker,
} from "../../task-tracker-settings.js";
import type {
  ClaimTaskResult,
  ClaimedTask,
  CompletionSyncResult,
  GitHubIssue,
  GitHubIssueClaimCommentMetadata,
  GitHubIssueComment,
  GitHubIssueSection,
  ParsedGitHubIssueClaimComment,
} from "../types.js";

export type {
  GitHubIssue,
  GitHubIssueComment,
} from "../types.js";

const GITHUB_ISSUE_CLAIM_COMMENT_TYPE = "workers-issue-claim";
const GITHUB_ISSUE_CLAIM_COMMENT_VERSION = 1;
const GITHUB_ISSUE_CLAIM_CODE_FENCE = "workers-issue-claim";
const WORKER_TASK_SPEC_COMMENT_START = "<!-- workers-task-spec:v1 -->";
const WORKER_TASK_SPEC_COMMENT_END = "<!-- /workers-task-spec -->";
const COMMENT_CORRECTION_WINDOW_MS = 30 * 60 * 1000;

interface CreateGitHubIssueTaskOptions {
  commentMode?: "append" | "correct-latest";
}

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

function parseGitHubIssueTaskSpecComment(body: string): string | undefined {
  const match = body.match(
    /<!-- workers-task-spec:v1 -->\s*```(?:text)?\s*([\s\S]*?)\s*```\s*<!-- \/workers-task-spec -->/i,
  );
  const item = match?.[1]?.trim();
  return item || undefined;
}

function parseGitHubIssueNumber(issueUrl: string): number | undefined {
  const match = issueUrl.trim().match(/\/issues\/(\d+)$/);
  if (!match) {
    return undefined;
  }

  const issueNumber = Number(match[1]);
  return Number.isInteger(issueNumber) && issueNumber > 0
    ? issueNumber
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeGitHubIssueClaimCommentMetadata(
  value: unknown,
): GitHubIssueClaimCommentMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = typeof value.type === "string" ? value.type : "";
  const version = value.version;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  const cli = typeof value.cli === "string" ? value.cli.trim() : "";
  const trackerName = typeof value.trackerName === "string" ? value.trackerName.trim() : "";
  const repository = typeof value.repository === "string" ? value.repository.trim() : "";
  const issueNumber = typeof value.issueNumber === "number" ? value.issueNumber : Number.NaN;
  const claimedAt = typeof value.claimedAt === "string" ? value.claimedAt.trim() : "";

  if (
    type !== GITHUB_ISSUE_CLAIM_COMMENT_TYPE
    || version !== GITHUB_ISSUE_CLAIM_COMMENT_VERSION
    || !sessionId
    || !cli
    || !trackerName
    || !repository
    || !Number.isInteger(issueNumber)
    || issueNumber <= 0
    || !claimedAt
  ) {
    return undefined;
  }

  return {
    type: GITHUB_ISSUE_CLAIM_COMMENT_TYPE,
    version: GITHUB_ISSUE_CLAIM_COMMENT_VERSION,
    sessionId,
    cli,
    trackerName,
    repository,
    issueNumber,
    claimedAt,
  };
}

function compareGitHubIssueClaimCommentOrder(
  left: GitHubIssueComment,
  right: GitHubIssueComment,
): number {
  if (left.id !== right.id) {
    return left.id - right.id;
  }

  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }

  return left.body.localeCompare(right.body);
}

function compareGitHubIssueTaskSpecCommentOrder(
  left: GitHubIssueComment,
  right: GitHubIssueComment,
): number {
  const leftTimestamp = Date.parse(left.updatedAt ?? left.createdAt) || 0;
  const rightTimestamp = Date.parse(right.updatedAt ?? right.createdAt) || 0;
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return left.id - right.id;
}

function findEditableGitHubTaskSpecComment(
  comments: GitHubIssueComment[],
): GitHubIssueComment | undefined {
  if (comments.length === 0) {
    return undefined;
  }

  const latestComment = [...comments].sort(compareGitHubIssueTaskSpecCommentOrder).at(-1);
  if (!latestComment || !parseGitHubIssueTaskSpecComment(latestComment.body)) {
    return undefined;
  }

  const referenceTimestamp = latestComment.updatedAt ?? latestComment.createdAt;
  const ageMs = Date.now() - Date.parse(referenceTimestamp);
  return ageMs <= COMMENT_CORRECTION_WINDOW_MS ? latestComment : undefined;
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

export function renderGitHubIssueClaimComment(
  message: string,
  metadata: Omit<GitHubIssueClaimCommentMetadata, "type" | "version">,
): string {
  const normalizedMessage = message.trim() || "I will work on this.";
  const body = JSON.stringify(
    {
      type: GITHUB_ISSUE_CLAIM_COMMENT_TYPE,
      version: GITHUB_ISSUE_CLAIM_COMMENT_VERSION,
      ...metadata,
    },
    null,
    2,
  );

  return `${normalizedMessage}\n\n\`\`\`${GITHUB_ISSUE_CLAIM_CODE_FENCE}\n${body}\n\`\`\``;
}

export function parseGitHubIssueClaimComment(
  commentBody: string,
): ParsedGitHubIssueClaimComment | undefined {
  const match = commentBody.match(
    new RegExp(
      `^([\\s\\S]*?)\\n\\n\`\`\`${GITHUB_ISSUE_CLAIM_CODE_FENCE}\\n([\\s\\S]+?)\\n\`\`\`\\s*$`,
    ),
  );
  if (!match) {
    return undefined;
  }

  const message = match[1].trim();
  if (!message) {
    return undefined;
  }

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(match[2]);
  } catch {
    return undefined;
  }

  const metadata = normalizeGitHubIssueClaimCommentMetadata(parsedMetadata);
  if (!metadata) {
    return undefined;
  }

  return {
    message,
    metadata,
  };
}

export function selectWinningGitHubIssueClaimComment(
  comments: GitHubIssueComment[],
): (GitHubIssueComment & ParsedGitHubIssueClaimComment) | undefined {
  const claimsBySession = new Map<
    string,
    GitHubIssueComment & ParsedGitHubIssueClaimComment
  >();

  for (const comment of comments) {
    const parsedComment = parseGitHubIssueClaimComment(comment.body);
    if (!parsedComment) {
      continue;
    }

    const claimComment = {
      ...comment,
      ...parsedComment,
    };
    const existingClaim = claimsBySession.get(parsedComment.metadata.sessionId);
    if (
      !existingClaim
      || compareGitHubIssueClaimCommentOrder(claimComment, existingClaim) < 0
    ) {
      claimsBySession.set(parsedComment.metadata.sessionId, claimComment);
    }
  }

  return [...claimsBySession.values()].sort(compareGitHubIssueClaimCommentOrder)[0];
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

async function listGitHubIssueComments(
  tracker: ResolvedGitHubIssuesTaskTracker,
  issueNumber: number,
): Promise<GitHubIssueComment[]> {
  const result =
    await $`gh api repos/${tracker.repository}/issues/${String(issueNumber)}/comments?per_page=100`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to load comments for GitHub issue #${issueNumber} in ${tracker.repository}.`,
    );
  }

  const comments = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  return comments
    .filter((comment) => typeof comment.id === "number" && typeof comment.body === "string")
    .map((comment) => ({
      id: comment.id as number,
      body: comment.body as string,
      createdAt:
        typeof comment.created_at === "string"
          ? comment.created_at
          : typeof comment.createdAt === "string"
            ? comment.createdAt
            : "",
      updatedAt:
        typeof comment.updated_at === "string"
          ? comment.updated_at
          : typeof comment.updatedAt === "string"
            ? comment.updatedAt
            : undefined,
      authorLogin:
        isRecord(comment.user) && typeof comment.user.login === "string"
          ? comment.user.login
          : undefined,
    }));
}

async function loadGitHubIssueTaskSpecItem(
  tracker: ResolvedGitHubIssuesTaskTracker,
  issueNumber: number,
): Promise<string | undefined> {
  try {
    const comments = await listGitHubIssueComments(tracker, issueNumber);
    return comments
      .sort(compareGitHubIssueTaskSpecCommentOrder)
      .map((comment) => parseGitHubIssueTaskSpecComment(comment.body))
      .filter((item): item is string => Boolean(item))
      .at(-1);
  } catch {
    return undefined;
  }
}

async function attachGitHubIssueTaskSpecs(
  tracker: ResolvedGitHubIssuesTaskTracker,
  issues: GitHubIssue[],
): Promise<GitHubIssue[]> {
  return Promise.all(issues.map(async (issue) => ({
    ...issue,
    taskSpecItem: await loadGitHubIssueTaskSpecItem(tracker, issue.number),
  })));
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

  const issues = sortGitHubIssuesByCreatedAt(JSON.parse(result.stdout) as GitHubIssue[]);
  return attachGitHubIssueTaskSpecs(tracker, issues);
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

  const issue = JSON.parse(issueResult.stdout) as GitHubIssue;
  const existingLabels = new Set((issue.labels ?? []).map((label) => label.name));

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

async function createGitHubIssueComment(
  tracker: ResolvedGitHubIssuesTaskTracker,
  issueNumber: number,
  body: string,
): Promise<GitHubIssueComment> {
  const result =
    await $`gh api repos/${tracker.repository}/issues/${String(issueNumber)}/comments --method POST --field body=${body}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create a claim comment for GitHub issue #${issueNumber} in ${tracker.repository}.`,
    );
  }

  const comment = JSON.parse(result.stdout) as Record<string, unknown>;
  return {
    id: comment.id as number,
    body: comment.body as string,
    createdAt:
      typeof comment.created_at === "string"
        ? comment.created_at
        : typeof comment.createdAt === "string"
          ? comment.createdAt
          : new Date().toISOString(),
    updatedAt:
      typeof comment.updated_at === "string"
        ? comment.updated_at
        : typeof comment.updatedAt === "string"
          ? comment.updatedAt
          : undefined,
    authorLogin:
      isRecord(comment.user) && typeof comment.user.login === "string"
        ? comment.user.login
        : undefined,
  };
}

async function deleteGitHubIssueComment(
  tracker: ResolvedGitHubIssuesTaskTracker,
  commentId: number,
): Promise<void> {
  await $`gh api repos/${tracker.repository}/issues/comments/${String(commentId)} --method DELETE`
    .quiet()
    .nothrow();
}

async function publishGitHubIssueTaskSpecComment(
  tracker: ResolvedGitHubIssuesTaskTracker,
  issueNumber: number,
  item: string,
  options: CreateGitHubIssueTaskOptions = {},
): Promise<void> {
  const body = renderGitHubIssueTaskSpecComment(item);

  if (options.commentMode === "correct-latest") {
    const comments = await listGitHubIssueComments(tracker, issueNumber);
    const editableComment = findEditableGitHubTaskSpecComment(comments);
    if (editableComment) {
      const result =
        await $`gh api repos/${tracker.repository}/issues/comments/${String(editableComment.id)} --method PATCH --field body=${body}`
          .quiet()
          .nothrow();
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to update worker task spec comment for GitHub issue #${issueNumber} in ${tracker.repository}.`,
        );
      }
      return;
    }
  }

  const result =
    await $`gh api repos/${tracker.repository}/issues/${String(issueNumber)}/comments --method POST --field body=${body}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create worker task spec comment for GitHub issue #${issueNumber} in ${tracker.repository}.`,
    );
  }
}

async function resolveWinningGitHubIssueClaimComment(
  tracker: ResolvedGitHubIssuesTaskTracker,
  issueNumber: number,
  ownComment?: GitHubIssueComment,
): Promise<(GitHubIssueComment & ParsedGitHubIssueClaimComment) | undefined> {
  const comments = await listGitHubIssueComments(tracker, issueNumber);
  const commentsWithOwnComment =
    ownComment && !comments.some((comment) => comment.id === ownComment.id)
      ? [...comments, ownComment]
      : comments;
  return selectWinningGitHubIssueClaimComment(commentsWithOwnComment);
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
  const selectedIssue = readyIssues.find((issue) => renderIssueItem(issue) === selection.item);
  if (!selectedIssue) {
    throw new Error(
      `Failed to resolve claimed GitHub issue for "${summary}" in ${tracker.repository}.`,
    );
  }

  await ensureGitHubLabels(tracker);

  const claimComment = await createGitHubIssueComment(
    tracker,
    selectedIssue.number,
    renderGitHubIssueClaimComment(tracker.claimComment.message, {
      sessionId: `${cli}-${randomUUID()}`,
      cli,
      trackerName: tracker.name,
      repository: tracker.repository,
      issueNumber: selectedIssue.number,
      claimedAt: new Date().toISOString(),
    }),
  );

  const winningClaimBeforeLabelEdit = await resolveWinningGitHubIssueClaimComment(
    tracker,
    selectedIssue.number,
    claimComment,
  );
  if (winningClaimBeforeLabelEdit?.id !== claimComment.id) {
    await deleteGitHubIssueComment(tracker, claimComment.id);
    return {
      status: "no-claim",
      reason: "claimed-by-other-worker",
    };
  }

  const editResult =
    await $`gh issue edit ${String(selectedIssue.number)} --repo ${tracker.repository} --remove-label ${tracker.labels.ready} --add-label ${tracker.labels.inProgress}`
      .quiet()
      .nothrow();
  if (editResult.exitCode !== 0) {
    const winningClaimAfterFailedEdit = await resolveWinningGitHubIssueClaimComment(
      tracker,
      selectedIssue.number,
      claimComment,
    );
    if (winningClaimAfterFailedEdit?.id !== claimComment.id) {
      await deleteGitHubIssueComment(tracker, claimComment.id);
      return {
        status: "no-claim",
        reason: "claimed-by-other-worker",
      };
    }

    throw new Error(
      `Failed to claim GitHub issue #${selectedIssue.number} in ${tracker.repository}.`,
    );
  }

  const winningClaimAfterLabelEdit = await resolveWinningGitHubIssueClaimComment(
    tracker,
    selectedIssue.number,
    claimComment,
  );
  if (winningClaimAfterLabelEdit?.id !== claimComment.id) {
    await deleteGitHubIssueComment(tracker, claimComment.id);
    return {
      status: "no-claim",
      reason: "claimed-by-other-worker",
    };
  }

  const refreshedOpenIssues = await listOpenGitHubIssues(tracker);
  const refreshedSections = partitionGitHubIssuesBySection(refreshedOpenIssues, tracker);
  const refreshedSelectedIssue = refreshedOpenIssues.find(
    (issue) => issue.number === selectedIssue.number,
  );
  const localTodoContent = refreshedSelectedIssue
    && getGitHubIssueSection(refreshedSelectedIssue, tracker) === "in-progress"
    ? renderTodoFromIssues(
        refreshedSections["in-progress"],
        refreshedSections.ready,
      )
    : renderTodoFromIssues(
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
  const title = itemLines[0].replace(/^- /, "").trim();
  const body = filterGitHubIssueBodyLines(itemLines.slice(1)).join("\n").trim();
  const normalizedItem = normalizeGitHubIssueTaskItem(itemLines);

  if (issueNumber !== undefined) {
    const issue = await getGitHubIssue(tracker, issueNumber);

    if (section === "ready") {
      await ensureGitHubLabels(tracker);
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

    await publishGitHubIssueTaskSpecComment(
      tracker,
      issueNumber,
      normalizedItem,
      options,
    );
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

  const issueUrl = result.stdout.trim();
  const createdIssueNumber = parseGitHubIssueNumber(issueUrl);
  if (createdIssueNumber === undefined) {
    throw new Error(
      `Failed to determine GitHub issue number from "${issueUrl}" in ${tracker.repository}.`,
    );
  }

  await publishGitHubIssueTaskSpecComment(
    tracker,
    createdIssueNumber,
    normalizedItem,
    options,
  );
  return issueUrl;
}
