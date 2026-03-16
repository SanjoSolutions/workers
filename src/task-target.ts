import { mkdirSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import { $ } from "zx";

export interface ClaimedTaskTarget {
  itemType: string;
  repoPath: string;
  repoFieldValue: string;
  source: "repo-field" | "summary-path" | "invocation-repo";
  remoteUrl?: string;
  remoteName: string;
}

export function extractTodoField(item: string, field: string): string {
  const match = item.match(new RegExp(`^\\s+- ${field}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function expandHomePath(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function resolveTaskPath(rawPath: string, sharedTodoRepoRoot: string): string {
  const expanded = expandHomePath(rawPath.trim());
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(sharedTodoRepoRoot, expanded);
}

function inferRepoPathFromSummary(item: string): string {
  const summaryLine = item.split("\n")[0] ?? "";
  const matches = [...summaryLine.matchAll(/`([^`]+)`/g)];

  for (const match of matches) {
    const candidate = match[1]?.trim() ?? "";
    if (
      candidate.startsWith("~/")
      || candidate.startsWith("/")
      || candidate.startsWith("./")
      || candidate.startsWith("../")
    ) {
      return candidate;
    }
  }

  return "";
}

export function resolveClaimedTaskTarget(
  item: string,
  itemType: string,
  sharedTodoRepoRoot: string,
  invocationRepoRoot?: string,
): ClaimedTaskTarget {
  const explicitRepo = extractTodoField(item, "Repo");
  const inferredRepo = explicitRepo ? "" : inferRepoPathFromSummary(item);
  const repoFieldValue = explicitRepo || inferredRepo;

  if (!repoFieldValue) {
    if (itemType === "new-project") {
      throw new Error(
        "Claimed new-project TODO is missing a target repo path. Add '- Repo: /absolute/or/relative/path' or include a backticked path in the summary.",
      );
    }

    if (!invocationRepoRoot) {
      throw new Error(
        "Claimed TODO does not specify a target repo, and workers was not launched from a git repo. Add '- Repo: ...' or run workers from the repo that should own the task.",
      );
    }

    return {
      itemType,
      repoPath: invocationRepoRoot,
      repoFieldValue: invocationRepoRoot,
      source: "invocation-repo",
      remoteUrl: extractTodoField(item, "Remote") || undefined,
      remoteName: extractTodoField(item, "Remote name") || "origin",
    };
  }

  return {
    itemType,
    repoPath: resolveTaskPath(repoFieldValue, sharedTodoRepoRoot),
    repoFieldValue,
    source: explicitRepo ? "repo-field" : "summary-path",
    remoteUrl: extractTodoField(item, "Remote") || undefined,
    remoteName: extractTodoField(item, "Remote name") || "origin",
  };
}

async function findGitRepoRoot(startPath: string): Promise<string | null> {
  const result =
    await $`git -C ${startPath} rev-parse --show-toplevel`.quiet().nothrow();
  if (result.exitCode !== 0) {
    return null;
  }
  const repoRoot = result.stdout.trim();
  return repoRoot || null;
}

async function ensureGitIdentity(repoRoot: string): Promise<void> {
  const nameResult =
    await $`git -C ${repoRoot} config --get user.name`.quiet().nothrow();
  if (nameResult.exitCode !== 0 || !nameResult.stdout.trim()) {
    await $`git -C ${repoRoot} config user.name Workers`.quiet().nothrow();
  }

  const emailResult =
    await $`git -C ${repoRoot} config --get user.email`.quiet().nothrow();
  if (emailResult.exitCode !== 0 || !emailResult.stdout.trim()) {
    await $`git -C ${repoRoot} config user.email workers@example.invalid`
      .quiet()
      .nothrow();
  }
}

async function ensureRemote(
  repoRoot: string,
  remoteName: string,
  remoteUrl?: string,
): Promise<void> {
  if (!remoteUrl) {
    return;
  }

  const existingResult =
    await $`git -C ${repoRoot} remote get-url ${remoteName}`.quiet().nothrow();
  const existingUrl = existingResult.stdout.trim();

  if (existingResult.exitCode === 0 && existingUrl === remoteUrl) {
    return;
  }

  if (existingResult.exitCode === 0 && existingUrl && existingUrl !== remoteUrl) {
    throw new Error(
      `Repo ${repoRoot} already has remote "${remoteName}" pointing at ${existingUrl}. Expected ${remoteUrl}.`,
    );
  }

  const addResult =
    await $`git -C ${repoRoot} remote add ${remoteName} ${remoteUrl}`.quiet().nothrow();
  if (addResult.exitCode !== 0) {
    throw new Error(`Failed to add remote "${remoteName}" to ${repoRoot}.`);
  }
}

async function ensureInitialCommit(repoRoot: string): Promise<void> {
  const headResult =
    await $`git -C ${repoRoot} rev-parse --verify HEAD`.quiet().nothrow();
  if (headResult.exitCode === 0) {
    return;
  }

  await ensureGitIdentity(repoRoot);
  const commitResult =
    await $`git -C ${repoRoot} commit --allow-empty -m "chore: initialize repository"`
      .quiet()
      .nothrow();
  if (commitResult.exitCode !== 0) {
    throw new Error(`Failed to create initial commit in ${repoRoot}.`);
  }
}

export async function ensureTaskRepo(
  target: ClaimedTaskTarget,
): Promise<{ repoRoot: string; bootstrapped: boolean }> {
  const existingRepoRoot = await findGitRepoRoot(target.repoPath);
  if (existingRepoRoot) {
    await ensureRemote(existingRepoRoot, target.remoteName, target.remoteUrl);
    return { repoRoot: existingRepoRoot, bootstrapped: false };
  }

  if (target.itemType !== "new-project") {
    throw new Error(
      `Claimed TODO targets ${target.repoPath}, but no git repo exists there. Use '- Type: New project' when the worker should create a new repo.`,
    );
  }

  mkdirSync(target.repoPath, { recursive: true });
  const entries = readdirSync(target.repoPath);
  if (entries.length > 0) {
    throw new Error(
      `Cannot bootstrap new repo at ${target.repoPath}: directory already exists and is not a git repo.`,
    );
  }

  const initResult =
    await $`git -C ${target.repoPath} init -b main`.quiet().nothrow();
  if (initResult.exitCode !== 0) {
    throw new Error(`Failed to initialize git repo at ${target.repoPath}.`);
  }

  await ensureRemote(target.repoPath, target.remoteName, target.remoteUrl);
  await ensureInitialCommit(target.repoPath);

  return {
    repoRoot: target.repoPath,
    bootstrapped: true,
  };
}
