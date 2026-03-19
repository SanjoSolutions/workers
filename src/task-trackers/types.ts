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

export interface GitHubIssueLabel {
  name: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  createdAt?: string;
  labels?: GitHubIssueLabel[];
}

export type GitHubIssueSection = "in-progress" | "ready" | "planned";
