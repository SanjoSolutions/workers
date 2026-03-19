import { createHash } from "crypto";
import { mkdirSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import { extractTodoField } from "./agent-prompt.js";
import { runGit } from "./git-cli.js";
import { findGitRepoRoot } from "./git-utils.js";
import { expandHomePath, sanitizeSegment } from "./path-utils.js";

export interface ClaimedItemTarget {
  itemType: string;
  repoPath: string;
  repoFieldValue: string;
  source: "repo-field" | "summary-path" | "no-repo";
  remoteUrl?: string;
  remoteName: string;
}

function buildNoRepoWorkspacePath(item: string): string {
  const summary = item.split("\n")[0]?.replace(/^- /, "").trim() || "task";
  const slug = sanitizeSegment(summary, "task").slice(0, 48);
  const hash = createHash("sha1").update(item).digest("hex").slice(0, 8);
  return path.join(os.homedir(), ".workers", "no-repo", `${slug}-${hash}`);
}

function isNoRepoValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "none" || normalized === "no-repo";
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

export function resolveClaimedItemTarget(
  item: string,
  itemType: string,
  sharedTodoRepoRoot: string,
): ClaimedItemTarget {
  const explicitRepo = extractTodoField(item, "Repo");
  const inferredRepo = explicitRepo ? "" : inferRepoPathFromSummary(item);
  const repoFieldValue = explicitRepo || inferredRepo;

  if (explicitRepo && isNoRepoValue(explicitRepo)) {
    return {
      itemType,
      repoPath: buildNoRepoWorkspacePath(item),
      repoFieldValue: explicitRepo,
      source: "no-repo",
      remoteUrl: undefined,
      remoteName: "origin",
    };
  }

  if (!repoFieldValue) {
    throw new Error(
      itemType === "new-project"
        ? "Claimed new-project item is missing a target repo path. Add '- Repo: /absolute/or/relative/path' or include a backticked path in the summary."
        : "Claimed item is missing a target repo path. Add '- Repo: /absolute/or/relative/path', '- Repo: none', or include a backticked path in the summary.",
    );
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

async function ensureGitIdentity(repoRoot: string): Promise<void> {
  const nameResult = await runGit(["-C", repoRoot, "config", "--get", "user.name"]);
  if (nameResult.exitCode !== 0 || !nameResult.stdout.trim()) {
    await runGit(["-C", repoRoot, "config", "user.name", "Workers"]);
  }

  const emailResult = await runGit(["-C", repoRoot, "config", "--get", "user.email"]);
  if (emailResult.exitCode !== 0 || !emailResult.stdout.trim()) {
    await runGit([
      "-C",
      repoRoot,
      "config",
      "user.email",
      "workers@example.invalid",
    ]);
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

  const existingResult = await runGit([
    "-C",
    repoRoot,
    "remote",
    "get-url",
    remoteName,
  ]);
  const existingUrl = existingResult.stdout.trim();

  if (existingResult.exitCode === 0 && existingUrl === remoteUrl) {
    return;
  }

  if (existingResult.exitCode === 0 && existingUrl && existingUrl !== remoteUrl) {
    throw new Error(
      `Repo ${repoRoot} already has remote "${remoteName}" pointing at ${existingUrl}. Expected ${remoteUrl}.`,
    );
  }

  const addResult = await runGit([
    "-C",
    repoRoot,
    "remote",
    "add",
    remoteName,
    remoteUrl,
  ]);
  if (addResult.exitCode !== 0) {
    throw new Error(`Failed to add remote "${remoteName}" to ${repoRoot}.`);
  }
}

async function ensureInitialCommit(repoRoot: string): Promise<void> {
  const headResult = await runGit(["-C", repoRoot, "rev-parse", "--verify", "HEAD"]);
  if (headResult.exitCode === 0) {
    return;
  }

  await ensureGitIdentity(repoRoot);
  const commitResult = await runGit([
    "-C",
    repoRoot,
    "commit",
    "--allow-empty",
    "-m",
    "chore: initialize repository",
  ]);
  if (commitResult.exitCode !== 0) {
    throw new Error(`Failed to create initial commit in ${repoRoot}.`);
  }
}

export async function ensureTaskRepo(
  target: ClaimedItemTarget,
): Promise<{ repoRoot: string; bootstrapped: boolean }> {
  if (target.source === "no-repo") {
    mkdirSync(target.repoPath, { recursive: true });

    const existingScratchRepo = await findGitRepoRoot(target.repoPath);
    if (existingScratchRepo) {
      return { repoRoot: existingScratchRepo, bootstrapped: false };
    }

    const initResult = await runGit([
      "-C",
      target.repoPath,
      "init",
      "-b",
      "main",
    ]);
    if (initResult.exitCode !== 0) {
      throw new Error(`Failed to initialize scratch repo at ${target.repoPath}.`);
    }

    await ensureInitialCommit(target.repoPath);
    return { repoRoot: target.repoPath, bootstrapped: true };
  }

  const existingRepoRoot = await findGitRepoRoot(target.repoPath);
  if (existingRepoRoot) {
    await ensureRemote(existingRepoRoot, target.remoteName, target.remoteUrl);
    return { repoRoot: existingRepoRoot, bootstrapped: false };
  }

  if (target.itemType !== "new-project") {
    throw new Error(
      `Claimed item targets ${target.repoPath}, but no git repo exists there. Use '- Type: New project' when the worker should create a new repo.`,
    );
  }

  mkdirSync(target.repoPath, { recursive: true });
  const entries = readdirSync(target.repoPath);
  if (entries.length > 0) {
    throw new Error(
      `Cannot bootstrap new repo at ${target.repoPath}: directory already exists and is not a git repo.`,
    );
  }

  const initResult = await runGit([
    "-C",
    target.repoPath,
    "init",
    "-b",
    "main",
  ]);
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
