import { $ } from "zx";
import * as log from "./log.js";
import type { ClaimedTask } from "./task-trackers.js";

export interface CreatePullRequestOptions {
  repoRoot: string;
  branchName: string;
  claimedTask: ClaimedTask;
}

export interface CreatePullRequestResult {
  status: "created" | "skipped" | "failed";
  url?: string;
  reason?: string;
}

function stripRuntimeMetadata(item: string): string {
  return item
    .split(/\r?\n/)
    .filter((line) => !/^\s+-\s*Repo:\s/i.test(line))
    .join("\n");
}

async function ensurePullRequestReadyLabel(
  repository: string,
  labelName: string,
): Promise<void> {
  const result =
    await $`gh label create ${labelName} --repo ${repository} --force --color ${"5319E7"} --description ${"Workers pull request ready queue"}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`Failed to ensure GitHub label "${labelName}" in ${repository}.`);
  }
}

async function moveGitHubIssueToPullRequestReady(claimedTask: ClaimedTask): Promise<void> {
  if (claimedTask.syncState.kind !== "github-issues") {
    return;
  }

  const { repository, issueNumber, labels } = claimedTask.syncState;
  await ensurePullRequestReadyLabel(repository, labels.prReady);

  const issueResult =
    await $`gh issue view ${String(issueNumber)} --repo ${repository} --json labels`
      .quiet()
      .nothrow();
  if (issueResult.exitCode !== 0) {
    throw new Error(`Failed to inspect GitHub issue #${issueNumber} in ${repository}.`);
  }

  const issue = JSON.parse(issueResult.stdout) as { labels?: Array<{ name?: string }> };
  const existingLabels = new Set((issue.labels ?? []).map((label) => label.name).filter(Boolean));

  for (const label of [labels.ready, labels.inProgress]) {
    if (!existingLabels.has(label)) {
      continue;
    }

    const removeResult =
      await $`gh issue edit ${String(issueNumber)} --repo ${repository} --remove-label ${label}`
        .quiet()
        .nothrow();
    if (removeResult.exitCode !== 0) {
      throw new Error(
        `Failed to remove GitHub label "${label}" from issue #${issueNumber} in ${repository}.`,
      );
    }
  }

  if (!existingLabels.has(labels.prReady)) {
    const addResult =
      await $`gh issue edit ${String(issueNumber)} --repo ${repository} --add-label ${labels.prReady}`
        .quiet()
        .nothrow();
    if (addResult.exitCode !== 0) {
      throw new Error(
        `Failed to add GitHub label "${labels.prReady}" to issue #${issueNumber} in ${repository}.`,
      );
    }
  }
}

async function getGitHubRemoteRepository(repoRoot: string): Promise<string | null> {
  const result =
    await $`git -C ${repoRoot} remote get-url origin`.quiet().nothrow();
  if (result.exitCode !== 0) {
    return null;
  }

  const remoteUrl = result.stdout.trim();
  // Parse owner/repo from https://github.com/owner/repo or git@github.com:owner/repo
  const httpsMatch = remoteUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  return null;
}

async function hasBranchCommits(repoRoot: string, branchName: string): Promise<boolean> {
  // Check if there are commits on the branch vs base
  const result =
    await $`git -C ${repoRoot} log --oneline ${branchName} --not --remotes --not --exclude=${branchName} --branches`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    return false;
  }
  return result.stdout.trim().length > 0;
}

async function buildPrBody(repoRoot: string, branchName: string, claimedTask: ClaimedTask): Promise<string> {
  // Get commit log for summary
  const logResult =
    await $`git -C ${repoRoot} log --oneline --no-merges ${branchName} --not --remotes --not --exclude=${branchName} --branches`
      .quiet()
      .nothrow();

  const commits = logResult.exitCode === 0 ? logResult.stdout.trim() : "";
  const cleanedItem = stripRuntimeMetadata(claimedTask.item).trim();

  let body = `## Summary\n\n${cleanedItem}\n`;

  if (commits) {
    body += `\n## Commits\n\n\`\`\`\n${commits}\n\`\`\`\n`;
  }

  // If task came from GitHub Issues, add "Closes #N" reference
  if (claimedTask.syncState.kind === "github-issues") {
    body += `\nCloses #${claimedTask.syncState.issueNumber}\n`;
  }

  return body;
}

export async function createWorkerPullRequest(
  options: CreatePullRequestOptions,
): Promise<CreatePullRequestResult> {
  const { repoRoot, branchName, claimedTask } = options;

  // Verify there are commits to push
  const hasCommits = await hasBranchCommits(repoRoot, branchName);
  if (!hasCommits) {
    return {
      status: "skipped",
      reason: "no-commits",
    };
  }

  // Detect GitHub remote repository
  const repository = await getGitHubRemoteRepository(repoRoot);
  if (!repository) {
    return {
      status: "skipped",
      reason: "no-github-remote",
    };
  }

  // Push the branch
  log.info(`Pushing branch ${branchName} to origin...`);
  const pushResult =
    await $`git -C ${repoRoot} push origin ${branchName}`.quiet().nothrow();
  if (pushResult.exitCode !== 0) {
    log.error(`Failed to push branch ${branchName}: ${pushResult.stderr.trim()}`);
    return {
      status: "failed",
      reason: `push-failed: ${pushResult.stderr.trim()}`,
    };
  }

  // Build PR title from TODO summary
  const title = claimedTask.summary;

  // Build PR body
  const body = await buildPrBody(repoRoot, branchName, claimedTask);

  // Create the pull request
  log.info(`Creating GitHub PR for branch ${branchName}...`);
  const prResult =
    await $`gh pr create --repo ${repository} --head ${branchName} --title ${title} --body ${body}`
      .quiet()
      .nothrow();

  if (prResult.exitCode !== 0) {
    const stderr = prResult.stderr.trim();
    log.error(`Failed to create GitHub PR: ${stderr}`);
    return {
      status: "failed",
      reason: `pr-create-failed: ${stderr}`,
    };
  }

  const prUrl = prResult.stdout.trim();
  log.info(`Created GitHub PR: ${prUrl}`);

  await moveGitHubIssueToPullRequestReady(claimedTask);

  return {
    status: "created",
    url: prUrl,
  };
}
