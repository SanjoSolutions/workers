import type { ResolvedGitHubIssuesTaskTracker } from "../task-tracker-settings.js";

export interface GitTodoSyncState {
  kind: "git-todo";
  todoPath: string;
  repoRoot: string;
  todoRelativePath: string;
}

export interface GitHubIssuesSyncState {
  kind: "github-issues";
  repository: string;
  issueNumber: number;
  labels: ResolvedGitHubIssuesTaskTracker["labels"];
}

export type TaskSyncState = GitTodoSyncState | GitHubIssuesSyncState;

export interface ClaimedItem {
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

export interface ClaimItemResult {
  status: "claimed" | "no-claim";
  reason: string;
  claimedItem?: ClaimedItem;
  claimedTask?: ClaimedItem;
}

export type ClaimedTask = ClaimedItem;
export type ClaimTaskResult = ClaimItemResult;

export interface CompletionSyncResult {
  status: "synced" | "pending";
}

export interface GitHubIssueLabel {
  name: string;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt?: string;
  authorLogin?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  createdAt?: string;
  labels?: GitHubIssueLabel[];
  taskSpecItem?: string;
}

export interface GitHubIssueClaimCommentMetadata {
  type: "workers-issue-claim";
  version: 1;
  sessionId: string;
  cli: string;
  trackerName: string;
  repository: string;
  issueNumber: number;
  claimedAt: string;
}

export interface ParsedGitHubIssueClaimComment {
  message: string;
  metadata: GitHubIssueClaimCommentMetadata;
}

export type GitHubIssueSection = "in-progress" | "ready" | "planned";
